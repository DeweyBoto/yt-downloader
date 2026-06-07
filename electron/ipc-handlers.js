// ─────────────────────────────────────────────────────────────────────────────
// electron/ipc-handlers.js
//
// Все IPC обработчики — бизнес-логика между renderer и системой.
//
// СТРУКТУРА:
//   register()     — регистрирует все ipcMain.handle() при старте
//   AUTH           — регистрация, локальный вход, OAuth
//   DOWNLOADS      — info, start, pause, resume, cancel
//   HISTORY        — getAll, delete, clear
//   SETTINGS       — getAll, set, reset
//   FILES          — readFileBase64, saveBase64File
//   UPDATER        — checkBinaries, getVersions
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { ipcMain, shell, app } = require('electron');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const axios   = require('axios');
const sharp   = require('sharp');

// Наши модули
const downloader = require('./downloader');
const updater    = require('./updater');

// ─── OAuth конфиг ─────────────────────────────────────────────────────────────
// В продакшене эти значения берутся из переменных окружения или зашитого конфига.
// Redirect URI использует deep link схему ytdl://
const OAUTH_CONFIG = {
  google: {
    clientId:     process.env.GOOGLE_CLIENT_ID     || 'YOUR_GOOGLE_CLIENT_ID',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'YOUR_GOOGLE_CLIENT_SECRET',
    authUrl:      'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl:     'https://oauth2.googleapis.com/token',
    userInfoUrl:  'https://www.googleapis.com/oauth2/v3/userinfo',
    redirectUri:  'ytdl://oauth/callback',
    scope:        'openid email profile',
  },
  github: {
    clientId:     process.env.GITHUB_CLIENT_ID     || 'YOUR_GITHUB_CLIENT_ID',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || 'YOUR_GITHUB_CLIENT_SECRET',
    authUrl:      'https://github.com/login/oauth/authorize',
    tokenUrl:     'https://github.com/login/oauth/access_token',
    userInfoUrl:  'https://api.github.com/user',
    redirectUri:  'ytdl://oauth/callback',
    scope:        'read:user user:email',
  },
};

// Хранилище state токенов для защиты от CSRF
// { state: { provider, createdAt } }
const pendingOAuthStates = new Map();

// Ссылка на mainWindow (обновляется из main.js)
let _mainWindow = null;

// ─────────────────────────────────────────────────────────────────────────────
// РЕГИСТРАЦИЯ ВСЕХ ОБРАБОТЧИКОВ
// ─────────────────────────────────────────────────────────────────────────────

function register({ store, db, mainWindow }) {
  _mainWindow = mainWindow;

  // При старте — сбрасываем зависшие загрузки
  db.resetStaleDownloads();

  registerAuthHandlers(db);
  registerDownloadHandlers(db);
  registerHistoryHandlers(db);
  registerSettingsHandlers(db);
  registerFileHandlers();
  registerUpdaterHandlers();
}

function updateMainWindow(win) {
  _mainWindow = win;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

function registerAuthHandlers(db) {

  // ── Регистрация нового пользователя ────────────────────────────────────────
  ipcMain.handle('auth:register', async (_, userData) => {
    try {
      const { name, email, password, avatarBase64 } = userData;

      // Валидация
      if (!name?.trim())     return { success: false, error: 'Введите имя' };
      if (!email?.trim())    return { success: false, error: 'Введите email' };
      if (!password)         return { success: false, error: 'Введите пароль' };
      if (password.length < 6) return { success: false, error: 'Пароль минимум 6 символов' };

      // Проверяем уникальность email
      const existing = db.getUserByEmail(email.trim().toLowerCase());
      if (existing) return { success: false, error: 'Этот email уже используется' };

      // Хешируем пароль (salt rounds = 10)
      const passwordHash = await bcrypt.hash(password, 10);

      // Сохраняем аватар если передан
      let avatarPath = null;
      if (avatarBase64) {
        avatarPath = await saveAvatar(avatarBase64, uuidv4());
      }

      // Создаём пользователя
      const userId = uuidv4();
      const user = db.createUser({
        id:           userId,
        name:         name.trim(),
        email:        email.trim().toLowerCase(),
        passwordHash,
        avatarPath,
        authProvider: 'local',
      });

      // Сохраняем сессию
      db.setSession(userId);

      return { success: true, userId: user.id };

    } catch (err) {
      console.error('[auth:register]', err);
      return { success: false, error: 'Ошибка при регистрации. Попробуйте снова.' };
    }
  });

  // ── Локальный вход ──────────────────────────────────────────────────────────
  ipcMain.handle('auth:login-local', async (_, { email, password }) => {
    try {
      if (!email || !password) {
        return { success: false, error: 'Введите email и пароль' };
      }

      const user = db.getUserByEmail(email.trim().toLowerCase());
      if (!user) {
        return { success: false, error: 'Пользователь не найден' };
      }

      if (user.auth_provider !== 'local') {
        return {
          success: false,
          error: `Этот аккаунт создан через ${user.auth_provider}. Войдите через него.`,
        };
      }

      const passwordMatch = await bcrypt.compare(password, user.password_hash);
      if (!passwordMatch) {
        return { success: false, error: 'Неверный пароль' };
      }

      db.setSession(user.id);
      return { success: true, userId: user.id };

    } catch (err) {
      console.error('[auth:login-local]', err);
      return { success: false, error: 'Ошибка входа. Попробуйте снова.' };
    }
  });

  // ── Запуск OAuth (открывает браузер) ───────────────────────────────────────
  ipcMain.handle('auth:start-oauth', async (_, provider) => {
    try {
      const config = OAUTH_CONFIG[provider];
      if (!config) return { success: false, error: `Неизвестный провайдер: ${provider}` };

      // Генерируем state для защиты от CSRF
      const state = uuidv4();
      pendingOAuthStates.set(state, {
        provider,
        createdAt: Date.now(),
      });

      // Удаляем устаревшие state (старше 10 минут)
      for (const [s, data] of pendingOAuthStates) {
        if (Date.now() - data.createdAt > 10 * 60 * 1000) {
          pendingOAuthStates.delete(s);
        }
      }

      // Строим URL авторизации
      const params = new URLSearchParams({
        client_id:     config.clientId,
        redirect_uri:  config.redirectUri,
        response_type: 'code',
        scope:         config.scope,
        state,
      });

      if (provider === 'google') {
        params.set('access_type', 'offline');
        params.set('prompt', 'consent');
      }

      const authUrl = `${config.authUrl}?${params.toString()}`;

      // Открываем в системном браузере
      await shell.openExternal(authUrl);

      return { success: true, state };

    } catch (err) {
      console.error('[auth:start-oauth]', err);
      return { success: false, error: 'Не удалось открыть браузер' };
    }
  });

  // ── Обработка OAuth callback (приходит из deep link) ──────────────────────
  ipcMain.handle('auth:handle-oauth-callback', async (_, { provider, code, state }) => {
    try {
      // Проверяем state (CSRF защита)
      const pendingState = pendingOAuthStates.get(state);
      if (!pendingState || pendingState.provider !== provider) {
        return { success: false, error: 'Недействительный state параметр' };
      }
      pendingOAuthStates.delete(state);

      const config = OAUTH_CONFIG[provider];

      // 1. Обмениваем code на access_token
      const tokenResponse = await exchangeCodeForToken(provider, config, code);
      if (!tokenResponse.success) return tokenResponse;

      const { accessToken, refreshToken, expiresAt } = tokenResponse;

      // 2. Получаем профиль пользователя
      const profileResponse = await fetchOAuthProfile(provider, config, accessToken);
      if (!profileResponse.success) return profileResponse;

      const { providerId, name, email, avatarUrl } = profileResponse;

      // 3. Ищем существующего пользователя
      let user = db.getUserByProvider(provider, providerId);
      let isNewUser = false;

      if (!user) {
        // Проверяем нет ли аккаунта с таким email
        if (email) {
          user = db.getUserByEmail(email);
        }

        if (!user) {
          // Создаём нового пользователя
          isNewUser = true;
          const userId = uuidv4();

          // Скачиваем аватар если есть
          let avatarPath = null;
          if (avatarUrl) {
            avatarPath = await downloadAndSaveAvatar(avatarUrl, userId);
          }

          user = db.createUser({
            id:           userId,
            name:         name || email?.split('@')[0] || 'Пользователь',
            email:        email ?? null,
            avatarPath,
            authProvider: provider,
            providerId,
          });
        } else {
          // Обновляем существующего — привязываем OAuth
          db.updateUser(user.id, {});
        }
      }

      // 4. Сохраняем токен
      db.upsertOAuthToken({
        id:           uuidv4(),
        userId:       user.id,
        provider,
        accessToken,
        refreshToken,
        expiresAt,
        scope: OAUTH_CONFIG[provider].scope,
      });

      // 5. Сохраняем сессию
      db.setSession(user.id);

      return { success: true, userId: user.id, isNewUser };

    } catch (err) {
      console.error('[auth:handle-oauth-callback]', err);
      return { success: false, error: 'Ошибка авторизации. Попробуйте снова.' };
    }
  });

  // ── Получить текущего пользователя ─────────────────────────────────────────
  ipcMain.handle('auth:get-current-user', () => {
    try {
      return db.getSessionUser();
    } catch {
      return null;
    }
  });

  // ── Обновить профиль ────────────────────────────────────────────────────────
  ipcMain.handle('auth:update-profile', async (_, { userId, name, email, avatarBase64 }) => {
    try {
      const updates = {};

      if (name !== undefined)  updates.name  = name.trim();
      if (email !== undefined) updates.email = email.trim().toLowerCase();

      if (avatarBase64) {
        // Удаляем старый аватар
        const user = db.getUserById(userId);
        if (user?.avatar_path) {
          const oldPath = path.join(app.getPath('userData'), user.avatar_path);
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
        updates.avatarPath = await saveAvatar(avatarBase64, userId);
      }

      const updatedUser = db.updateUser(userId, updates);
      return { success: true, user: updatedUser };

    } catch (err) {
      console.error('[auth:update-profile]', err);
      return { success: false, error: 'Ошибка обновления профиля' };
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DOWNLOAD HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

function registerDownloadHandlers(db) {

  // ── Получить информацию о медиа ─────────────────────────────────────────────
  ipcMain.handle('download:get-info', async (_, mediaUrl) => {
    try {
      if (!mediaUrl?.trim()) {
        return { success: false, error: 'Введите ссылку' };
      }

      const info = await downloader.getMediaInfo(mediaUrl.trim());
      return { success: true, ...info };

    } catch (err) {
      console.error('[download:get-info]', err);
      return {
        success: false,
        error: err.message || 'Не удалось получить информацию о видео',
      };
    }
  });

  // ── Запустить загрузку ──────────────────────────────────────────────────────
  ipcMain.handle('download:start', async (_, options) => {
    try {
      const {
        url, type, format, quality, fps, bitrate,
        outputPath, title, thumbnail, duration, site,
        playlistId, playlistIndex,
      } = options;

      // Определяем папку сохранения
      // Приоритет: 1) явно указанная outputPath, 2) настройки, 3) Downloads
      const downloadPath = outputPath
        || db.getSetting('downloadPath')
        || app.getPath('downloads');

      // Создаём папку если нет
      if (!fs.existsSync(downloadPath)) {
        fs.mkdirSync(downloadPath, { recursive: true });
      }

      // Получаем текущего пользователя
      const user = db.getSessionUser();
      const downloadId = uuidv4();

      // Сохраняем запись в БД
      db.createDownload({
        id:            downloadId,
        userId:        user?.id ?? null,
        url,
        title,
        thumbnail,
        type,
        format,
        quality,
        fps:           fps    ? parseInt(fps)  : null,
        bitrate,
        duration,
        site,
        playlistId:    playlistId    ?? null,
        playlistIndex: playlistIndex ?? null,
      });

      // Запускаем загрузку через downloader.js
      downloader.startDownload({
        downloadId,
        url,
        type,
        format,
        quality,
        fps,
        bitrate,
        outputPath: downloadPath,

        // Коллбэки прогресса
        onProgress: ({ percent, speed, eta, size }) => {
          // Обновляем БД
          db.updateDownload(downloadId, {
            status:   'downloading',
            progress: percent,
          });

          // Отправляем прогресс в renderer
          _mainWindow?.webContents.send('download:progress', {
            downloadId, percent, speed, eta, size,
          });
        },

        onComplete: ({ filePath, fileSize }) => {
          db.updateDownload(downloadId, {
            status:   'completed',
            progress: 100,
            filePath,
            fileSize,
          });

          _mainWindow?.webContents.send('download:complete', {
            downloadId, filePath, fileSize,
          });
        },

        onError: (error) => {
          db.updateDownload(downloadId, {
            status:       'failed',
            errorMessage: error.message || String(error),
          });

          _mainWindow?.webContents.send('download:error', {
            downloadId,
            error: error.message || String(error),
          });
        },

        onQueued: (queueInfo) => {
          _mainWindow?.webContents.send('download:queued', {
            downloadId,
            ...queueInfo,
          });
        },
      });

      return { success: true, downloadId };

    } catch (err) {
      console.error('[download:start]', err);
      return { success: false, error: err.message || 'Ошибка запуска загрузки' };
    }
  });

  // ── Пауза ───────────────────────────────────────────────────────────────────
  ipcMain.handle('download:pause', async (_, downloadId) => {
    try {
      downloader.pauseDownload(downloadId);
      db.updateDownload(downloadId, { status: 'paused' });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ── Возобновить ─────────────────────────────────────────────────────────────
  ipcMain.handle('download:resume', async (_, downloadId) => {
    try {
      const record = db.getDownloadById(downloadId);
      if (!record) return { success: false, error: 'Загрузка не найдена' };

      downloader.resumeDownload(downloadId, record);
      db.updateDownload(downloadId, { status: 'downloading' });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ── Отмена ──────────────────────────────────────────────────────────────────
  ipcMain.handle('download:cancel', async (_, downloadId) => {
    try {
      downloader.cancelDownload(downloadId);
      db.updateDownload(downloadId, {
        status:       'cancelled',
        errorMessage: 'Отменено пользователем',
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ── Открыть в проводнике ────────────────────────────────────────────────────
  ipcMain.handle('download:show-in-folder', async (_, filePath) => {
    try {
      if (fs.existsSync(filePath)) {
        shell.showItemInFolder(filePath);
        return { success: true };
      }
      return { success: false, error: 'Файл не найден' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HISTORY HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

function registerHistoryHandlers(db) {

  ipcMain.handle('history:get-all', (_, options = {}) => {
    try {
      const user = db.getSessionUser();
      return db.getDownloads({
        userId: user?.id,
        ...options,
      });
    } catch (err) {
      console.error('[history:get-all]', err);
      return { items: [], total: 0 };
    }
  });

  ipcMain.handle('history:delete', (_, { recordId, deleteFile }) => {
    try {
      const record = db.deleteDownload(recordId);

      if (deleteFile && record?.file_path && fs.existsSync(record.file_path)) {
        fs.unlinkSync(record.file_path);
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('history:clear', (_, { deleteFiles }) => {
    try {
      const user = db.getSessionUser();
      if (!user) return { success: false, error: 'Нет активной сессии' };

      const records = db.clearDownloads(user.id);

      if (deleteFiles) {
        for (const record of records) {
          if (record.file_path && fs.existsSync(record.file_path)) {
            try { fs.unlinkSync(record.file_path); } catch { /* игнорируем */ }
          }
        }
      }

      return { success: true, deleted: records.length };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

function registerSettingsHandlers(db) {

  ipcMain.handle('settings:get-all', () => {
    try {
      return db.getAllSettings();
    } catch (err) {
      console.error('[settings:get-all]', err);
      return {};
    }
  });

  ipcMain.handle('settings:set', (_, updates) => {
    try {
      db.setSettings(updates);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('settings:reset', () => {
    try {
      db.resetSettings();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

function registerFileHandlers() {

  // Читаем файл как base64 (только из userData директории — безопасно)
  ipcMain.handle('fs:read-file-base64', (_, relativePath) => {
    try {
      // Защита от path traversal: убираем .. и /
      const safePath = relativePath
        .replace(/\.\./g, '')
        .replace(/^[/\\]/, '');

      const fullPath = path.join(app.getPath('userData'), safePath);

      if (!fs.existsSync(fullPath)) return null;

      const buffer = fs.readFileSync(fullPath);
      const ext    = path.extname(fullPath).slice(1).toLowerCase();
      const mime   = ext === 'png' ? 'image/png' : 'image/jpeg';

      return `data:${mime};base64,${buffer.toString('base64')}`;
    } catch (err) {
      console.error('[fs:read-file-base64]', err);
      return null;
    }
  });

  // Сохраняем base64 файл (аватар при регистрации)
  ipcMain.handle('fs:save-base64-file', async (_, { data, filename }) => {
    try {
      const avatarsDir = path.join(app.getPath('userData'), 'avatars');
      if (!fs.existsSync(avatarsDir)) {
        fs.mkdirSync(avatarsDir, { recursive: true });
      }

      const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath     = path.join(avatarsDir, safeFilename);

      // Убираем data:image/...;base64, префикс
      const base64Data = data.replace(/^data:image\/\w+;base64,/, '');
      const buffer     = Buffer.from(base64Data, 'base64');

      // Обрабатываем через sharp: ресайз до 200x200, конвертируем в jpg
      await sharp(buffer)
        .resize(200, 200, { fit: 'cover', position: 'center' })
        .jpeg({ quality: 85 })
        .toFile(filePath);

      const relativePath = path.join('avatars', safeFilename);
      return { success: true, path: relativePath };

    } catch (err) {
      console.error('[fs:save-base64-file]', err);
      return { success: false, error: err.message };
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// UPDATER HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

function registerUpdaterHandlers() {

  ipcMain.handle('updater:check-binaries', async () => {
    try {
      const win = _mainWindow?.();

      const result = await updater.checkAndUpdate({
        silent: false,
        onProgress: (data) => {
          win?.webContents.send('updater:binary-progress', data);
        },
        onDone: (data) => {
          win?.webContents.send('updater:binary-done', data);
        },
      });

      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('updater:get-versions', async () => {
    try {
      return await updater.getCurrentVersions();
    } catch (err) {
      return { ytdlp: 'unknown', ffmpeg: 'unknown' };
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Сохранить аватар из base64 строки.
 * Обрезает до 200x200 и конвертирует в JPEG.
 * @param {string} base64Data — с или без data:image prefix
 * @param {string} userId
 * @returns {string} relativePath — например 'avatars/uuid.jpg'
 */
async function saveAvatar(base64Data, userId) {
  const avatarsDir = path.join(app.getPath('userData'), 'avatars');
  if (!fs.existsSync(avatarsDir)) {
    fs.mkdirSync(avatarsDir, { recursive: true });
  }

  const filename = `${userId}.jpg`;
  const filePath = path.join(avatarsDir, filename);

  const cleanBase64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
  const buffer      = Buffer.from(cleanBase64, 'base64');

  await sharp(buffer)
    .resize(200, 200, { fit: 'cover', position: 'center' })
    .jpeg({ quality: 85 })
    .toFile(filePath);

  return path.join('avatars', filename);
}

/**
 * Скачать аватар из URL и сохранить локально.
 * Используется для OAuth профилей (Google/GitHub возвращают URL аватара).
 * @param {string} avatarUrl
 * @param {string} userId
 * @returns {string | null} relativePath
 */
async function downloadAndSaveAvatar(avatarUrl, userId) {
  try {
    const response = await axios.get(avatarUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
    });

    const buffer = Buffer.from(response.data);

    const avatarsDir = path.join(app.getPath('userData'), 'avatars');
    if (!fs.existsSync(avatarsDir)) {
      fs.mkdirSync(avatarsDir, { recursive: true });
    }

    const filename = `${userId}.jpg`;
    const filePath = path.join(avatarsDir, filename);

    await sharp(buffer)
      .resize(200, 200, { fit: 'cover', position: 'center' })
      .jpeg({ quality: 85 })
      .toFile(filePath);

    return path.join('avatars', filename);

  } catch (err) {
    console.warn('[downloadAndSaveAvatar] Не удалось скачать аватар:', err.message);
    return null;
  }
}

/**
 * Обменять OAuth code на access_token.
 */
async function exchangeCodeForToken(provider, config, code) {
  try {
    const params = {
      client_id:     config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri:  config.redirectUri,
      grant_type:    'authorization_code',
    };

    const headers = provider === 'github'
      ? { Accept: 'application/json' }
      : {};

    const response = await axios.post(config.tokenUrl, params, { headers });
    const data     = response.data;

    if (data.error) {
      return { success: false, error: data.error_description || data.error };
    }

    const expiresAt = data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : null;

    return {
      success:      true,
      accessToken:  data.access_token,
      refreshToken: data.refresh_token ?? null,
      expiresAt,
    };

  } catch (err) {
    console.error('[exchangeCodeForToken]', err.message);
    return { success: false, error: 'Не удалось получить токен' };
  }
}

/**
 * Получить профиль пользователя через OAuth API.
 */
async function fetchOAuthProfile(provider, config, accessToken) {
  try {
    const response = await axios.get(config.userInfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept:        'application/json',
      },
    });

    const data = response.data;

    if (provider === 'google') {
      return {
        success:    true,
        providerId: data.sub,
        name:       data.name,
        email:      data.email,
        avatarUrl:  data.picture ?? null,
      };
    }

    if (provider === 'github') {
      // GitHub может не отдавать email в основном запросе
      let email = data.email;
      if (!email) {
        try {
          const emailResp = await axios.get('https://api.github.com/user/emails', {
            headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
          });
          const primary = emailResp.data.find((e) => e.primary && e.verified);
          email = primary?.email ?? null;
        } catch { /* оставляем null */ }
      }

      return {
        success:    true,
        providerId: String(data.id),
        name:       data.name || data.login,
        email,
        avatarUrl:  data.avatar_url ?? null,
      };
    }

    return { success: false, error: 'Неизвестный провайдер' };

  } catch (err) {
    console.error('[fetchOAuthProfile]', err.message);
    return { success: false, error: 'Не удалось получить профиль' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = { register, updateMainWindow };
