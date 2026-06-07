// ─────────────────────────────────────────────────────────────────────────────
// electron/preload.js
//
// Безопасный мост между Main Process (Node.js) и Renderer (React).
//
// КАК ЭТО РАБОТАЕТ:
//   contextBridge.exposeInMainWorld('api', { ... })
//   создаёт объект window.api в React-приложении.
//   React НИКОГДА не видит Node.js напрямую — только эти методы.
//
// ПРАВИЛО БЕЗОПАСНОСТИ:
//   Здесь только тонкая обёртка над ipcRenderer.
//   Никакой бизнес-логики — она вся в main/ipc-handlers.js.
//   Никаких require() чужих модулей — только electron.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// ─────────────────────────────────────────────────────────────────────────────
// ВСПОМОГАТЕЛЬНЫЕ ОБЁРТКИ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Безопасная подписка на IPC-событие.
 * Возвращает функцию отписки — React вызывает её в useEffect cleanup.
 *
 * @param {string}   channel  — название канала
 * @param {Function} callback — (data) => void
 * @returns {Function} unsubscribe
 */
function on(channel, callback) {
  // Обёртка: убираем первый аргумент (event) — renderer его не должен видеть
  const wrapped = (_, data) => callback(data);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

/**
 * Одноразовая подписка — автоматически отписывается после первого вызова.
 */
function once(channel, callback) {
  ipcRenderer.once(channel, (_, data) => callback(data));
}

// ─────────────────────────────────────────────────────────────────────────────
// ЭКСПОЗИЦИЯ API В RENDERER
// window.api — единственная точка входа для React
// ─────────────────────────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld('api', {

  // ── УПРАВЛЕНИЕ ОКНОМ ─────────────────────────────────────────────────────
  // Кастомный titlebar вызывает эти методы
  window: {
    minimize:        ()  => ipcRenderer.send('window:minimize'),
    maximizeToggle:  ()  => ipcRenderer.send('window:maximize-toggle'),
    close:           ()  => ipcRenderer.send('window:close'),
    hide:            ()  => ipcRenderer.send('window:hide'),
    isMaximized:     ()  => ipcRenderer.invoke('window:is-maximized'),

    // Подписка на изменение состояния окна (развёрнуто/свёрнуто/fullscreen)
    // Используется в TitleBar.jsx для обновления иконки кнопки maximize
    onStateChanged: (cb) => on('window:state-changed', cb),
  },

  // ── СИСТЕМНАЯ ИНФОРМАЦИЯ ─────────────────────────────────────────────────
  system: {
    // Возвращает { platform, arch, osUsername, homeDir, appVersion,
    //              downloadsDir, userDataDir }
    getInfo: () => ipcRenderer.invoke('system:get-info'),

    // Подписка на данные текущего пользователя (приходят при открытии mainWindow)
    onUserData: (cb) => on('app:user-data', cb),
  },

  // ── ДИАЛОГИ ──────────────────────────────────────────────────────────────
  dialog: {
    // Открывает нативный диалог выбора папки
    // Возвращает string | null
    openFolder: () => ipcRenderer.invoke('dialog:open-folder'),
  },

  // ── АУТЕНТИФИКАЦИЯ — РЕГИСТРАЦИЯ ─────────────────────────────────────────
  auth: {
    /**
     * Регистрация нового пользователя.
     * @param {{ name, email, password, avatarPath }} userData
     * @returns {{ success, userId, error? }}
     */
    register: (userData) =>
      ipcRenderer.invoke('auth:register', userData),

    /**
     * Вход по email + пароль (локальный аккаунт).
     * @param {{ email, password }} credentials
     * @returns {{ success, userId, error? }}
     */
    loginLocal: (credentials) =>
      ipcRenderer.invoke('auth:login-local', credentials),

    /**
     * Запуск OAuth через браузер.
     * Открывает браузер на странице Google/GitHub авторизации.
     * Результат приходит через onOAuthCallback / onOAuthError.
     * @param {'google' | 'github'} provider
     */
    startOAuth: (provider) =>
      ipcRenderer.invoke('auth:start-oauth', provider),

    /**
     * Обмен OAuth code на токен и получение профиля пользователя.
     * Вызывается автоматически когда приходит deep link callback.
     * @param {{ provider, code, state }} oauthData
     * @returns {{ success, userId, isNewUser, error? }}
     */
    handleOAuthCallback: (oauthData) =>
      ipcRenderer.invoke('auth:handle-oauth-callback', oauthData),

    /**
     * Выход из аккаунта — закрывает main, открывает auth окно.
     */
    logout: () => ipcRenderer.invoke('auth:logout'),

    /**
     * Получить текущего пользователя из БД.
     * @returns {User | null}
     */
    getCurrentUser: () => ipcRenderer.invoke('auth:get-current-user'),

    /**
     * Обновить профиль пользователя (имя, email, фото).
     * @param {{ userId, name?, email?, avatarBase64? }} updates
     * @returns {{ success, error? }}
     */
    updateProfile: (updates) =>
      ipcRenderer.invoke('auth:update-profile', updates),

    // ── Подписки на OAuth события ──
    // Вызываются когда браузер редиректит на ytdl://oauth/callback
    onOAuthCallback: (cb) => on('oauth:callback', cb),
    onOAuthError:    (cb) => on('oauth:error', cb),

    // Уведомление что регистрация завершена (main.js слушает это один раз)
    notifyRegistrationComplete: (userId) =>
      ipcRenderer.send('auth:registration-complete', userId),

    // Уведомление что вход завершён
    notifyLoginComplete: (userId) =>
      ipcRenderer.send('auth:login-complete', userId),
  },

  // ── ОНБОРДИНГ ────────────────────────────────────────────────────────────
  onboarding: {
    /**
     * Завершить онбординг — помечает в БД и открывает главное окно.
     * @param {string} userId
     */
    complete: (userId) => ipcRenderer.send('onboard:complete', userId),
  },

  // ── ЗАГРУЗКИ ─────────────────────────────────────────────────────────────
  download: {
    /**
     * Получить информацию о медиа по URL (название, thumbnail, форматы).
     * @param {string} mediaUrl
     * @returns {{ title, thumbnail, duration, formats, error? }}
     */
    getInfo: (mediaUrl) =>
      ipcRenderer.invoke('download:get-info', mediaUrl),

    /**
     * Запустить загрузку.
     * @param {{
     *   url, type: 'video'|'audio'|'playlist-video'|'playlist-audio',
     *   format, quality, fps, bitrate, outputPath, downloadId
     * }} options
     * @returns {{ success, downloadId, error? }}
     */
    start: (options) =>
      ipcRenderer.invoke('download:start', options),

    /**
     * Поставить загрузку на паузу.
     * @param {string} downloadId
     */
    pause: (downloadId) =>
      ipcRenderer.invoke('download:pause', downloadId),

    /**
     * Возобновить загрузку.
     * @param {string} downloadId
     */
    resume: (downloadId) =>
      ipcRenderer.invoke('download:resume', downloadId),

    /**
     * Отменить и удалить загрузку.
     * @param {string} downloadId
     */
    cancel: (downloadId) =>
      ipcRenderer.invoke('download:cancel', downloadId),

    /**
     * Открыть папку с файлом в системном проводнике.
     * @param {string} filePath
     */
    showInFolder: (filePath) =>
      ipcRenderer.invoke('download:show-in-folder', filePath),

    // ── Подписки на события прогресса ──────────────────────────────────────

    /**
     * Прогресс загрузки.
     * @param {Function} cb — ({ downloadId, percent, speed, eta, size }) => void
     * @returns {Function} unsubscribe
     */
    onProgress: (cb) => on('download:progress', cb),

    /**
     * Загрузка завершена.
     * @param {Function} cb — ({ downloadId, filePath, size }) => void
     * @returns {Function} unsubscribe
     */
    onComplete: (cb) => on('download:complete', cb),

    /**
     * Ошибка загрузки.
     * @param {Function} cb — ({ downloadId, error }) => void
     * @returns {Function} unsubscribe
     */
    onError: (cb) => on('download:error', cb),

    /**
     * Загрузка добавлена в очередь (для плейлистов — каждый трек).
     * @param {Function} cb — ({ downloadId, title, thumbnail, index, total }) => void
     * @returns {Function} unsubscribe
     */
    onQueued: (cb) => on('download:queued', cb),
  },

  // ── ИСТОРИЯ ЗАГРУЗОК ─────────────────────────────────────────────────────
  history: {
    /**
     * Получить историю загрузок.
     * @param {{ limit?, offset?, search? }} options
     * @returns {DownloadRecord[]}
     */
    getAll: (options) =>
      ipcRenderer.invoke('history:get-all', options),

    /**
     * Удалить запись из истории.
     * @param {string} recordId
     * @param {boolean} deleteFile — удалить ли сам файл с диска
     */
    delete: (recordId, deleteFile) =>
      ipcRenderer.invoke('history:delete', { recordId, deleteFile }),

    /**
     * Очистить всю историю.
     * @param {boolean} deleteFiles — удалить ли файлы с диска
     */
    clear: (deleteFiles) =>
      ipcRenderer.invoke('history:clear', { deleteFiles }),
  },

  // ── НАСТРОЙКИ ────────────────────────────────────────────────────────────
  settings: {
    /**
     * Получить все настройки.
     * @returns {{ theme, accentColor, language, downloadPath,
     *             defaultFormat, defaultQuality, defaultFps,
     *             defaultBitrate, concurrentDownloads,
     *             autoUpdateBinaries, notifications }}
     */
    getAll: () => ipcRenderer.invoke('settings:get-all'),

    /**
     * Обновить одну или несколько настроек.
     * @param {Partial<Settings>} updates
     */
    set: (updates) => ipcRenderer.invoke('settings:set', updates),

    /**
     * Сбросить все настройки к значениям по умолчанию.
     */
    reset: () => ipcRenderer.invoke('settings:reset'),
  },

  // ── ОБНОВЛЕНИЕ БИНАРЕЙ (yt-dlp, ffmpeg) ──────────────────────────────────
  updater: {
    /**
     * Проверить и скачать новые версии yt-dlp и ffmpeg.
     * @returns {{ ytdlp: string, ffmpeg: string }} — версии после обновления
     */
    checkBinaries: () => ipcRenderer.invoke('updater:check-binaries'),

    /**
     * Получить текущие версии бинарей.
     * @returns {{ ytdlp: string, ffmpeg: string }}
     */
    getBinaryVersions: () => ipcRenderer.invoke('updater:get-versions'),

    // Прогресс скачивания бинарей (показываем при первом запуске)
    onBinaryProgress: (cb) => on('updater:binary-progress', cb),
    onBinaryDone:     (cb) => on('updater:binary-done', cb),
  },

  // ── ФАЙЛОВАЯ СИСТЕМА ─────────────────────────────────────────────────────
  fs: {
    /**
     * Прочитать файл как base64 (для превью аватара).
     * Только из разрешённых директорий (userData).
     * @param {string} relativePath — относительно userData
     * @returns {string | null} base64
     */
    readFileBase64: (relativePath) =>
      ipcRenderer.invoke('fs:read-file-base64', relativePath),

    /**
     * Сохранить base64 как файл (фото профиля при регистрации).
     * @param {{ data: string, filename: string }} options
     * @returns {{ success, path?, error? }}
     */
    saveBase64File: (options) =>
      ipcRenderer.invoke('fs:save-base64-file', options),
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// ЛОГИРОВАНИЕ В DEV-РЕЖИМЕ
// Выводим в консоль renderer все IPC вызовы для отладки
// ─────────────────────────────────────────────────────────────────────────────

if (process.env.NODE_ENV === 'development' || !process.env.NODE_ENV) {
  console.log(
    '%c[preload] contextBridge API загружен ✓',
    'color: #4ade80; font-weight: bold;'
  );
  console.log('%c[preload] Доступные методы: window.api', 'color: #94a3b8;');
}
