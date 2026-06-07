// ─────────────────────────────────────────────────────────────────────────────
// electron/main.js
//
// Точка входа главного процесса Electron.
// Отвечает за:
//   1. Создание и управление окнами (auth, onboarding, main)
//   2. Определение маршрута при запуске (регистрация / онбординг / главный экран)
//   3. Регистрацию всех IPC-обработчиков
//   4. Tray-иконку и системное меню
//   5. Безопасность (CSP, контекстная изоляция)
//   6. Авто-обновление приложения
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const {
  app,
  BrowserWindow,
  shell,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  dialog,
  protocol,
  net,
} = require('electron');

const path  = require('path');
const os    = require('os');
const fs    = require('fs');
const url   = require('url');

// Наши модули (импортируются после того как app готов)
let store;          // electron/store.js     — настройки (тема, язык, путь)
let db;             // electron/database.js  — SQLite обёртка
let ipcHandlers;    // electron/ipc-handlers.js
let updater;        // electron/updater.js   — авто-обновление бинарей

// ─── Глобальные ссылки на окна ───────────────────────────────────────────────
// Храним глобально чтобы GC не уничтожил окна
let mainWindow      = null;
let authWindow      = null;
let onboardWindow   = null;
let tray            = null;

// ─── Константы ───────────────────────────────────────────────────────────────
const isDev       = !app.isPackaged;
const DEV_URL     = 'http://localhost:5173';
const PRELOAD     = path.join(__dirname, 'preload.js');
const ICON_PATH   = path.join(__dirname, '..', 'assets', 'icons');

// Размеры окон
const WINDOW_SIZES = {
  auth:      { width: 480,  height: 640,  resizable: false },
  onboard:   { width: 760,  height: 560,  resizable: false },
  main:      { width: 1100, height: 720,  minWidth: 820, minHeight: 560 },
};

// ─── Единственный экземпляр приложения ───────────────────────────────────────
// Если пользователь запустит второй экземпляр — фокусируем первый
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  const win = mainWindow || authWindow || onboardWindow;
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// ─── Безопасность: отключаем навигацию на внешние URL ────────────────────────
app.on('web-contents-created', (_, contents) => {
  // Запрещаем открывать новые окна через window.open (кроме OAuth popup)
  contents.setWindowOpenHandler(({ url: targetUrl }) => {
    // OAuth редиректы обрабатываются через deep link, не через popup
    shell.openExternal(targetUrl);
    return { action: 'deny' };
  });

  // Запрещаем навигацию на чужие URL из рендерера
  contents.on('will-navigate', (event, targetUrl) => {
    const parsedUrl = new URL(targetUrl);
    const allowedHosts = ['localhost', '127.0.0.1'];

    if (!allowedHosts.includes(parsedUrl.hostname)) {
      event.preventDefault();
      shell.openExternal(targetUrl);
    }
  });
});

// ─── Deep link для OAuth callback ─────────────────────────────────────────────
// Регистрируем кастомную схему ytdl:// для получения OAuth токенов
// Браузер после авторизации редиректит на ytdl://oauth/callback?code=xxx
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('ytdl', process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient('ytdl');
}

// Windows: deep link приходит через second-instance
app.on('second-instance', (_, argv) => {
  const deepLink = argv.find((arg) => arg.startsWith('ytdl://'));
  if (deepLink) handleOAuthCallback(deepLink);
});

// macOS: deep link приходит через open-url
app.on('open-url', (event, deepLinkUrl) => {
  event.preventDefault();
  handleOAuthCallback(deepLinkUrl);
});

// ─────────────────────────────────────────────────────────────────────────────
// ИНИЦИАЛИЗАЦИЯ ПРИЛОЖЕНИЯ
// ─────────────────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // 1. Загружаем store (синхронно — нужен сразу)
  const Store = require('./store');
  store = new Store();

  // 2. Инициализируем базу данных
  const Database = require('./database');
  db = new Database();
  db.initialize(); // Создаёт таблицы если их нет

  // 3. Регистрируем протокол для локальных файлов (аватары пользователей)
  //    ytdl-file://avatars/uuid.jpg → реальный путь на диске
  protocol.handle('ytdl-file', (request) => {
    const filePath = request.url
      .replace('ytdl-file://', '')
      .replace(/^\//, '');
    const fullPath = path.join(app.getPath('userData'), filePath);
    return net.fetch(url.pathToFileURL(fullPath).toString());
  });

  // 4. Регистрируем все IPC обработчики
  ipcHandlers = require('./ipc-handlers');
  ipcHandlers.register({ store, db, mainWindow: () => mainWindow });

  // 5. Определяем маршрут запуска
  await routeStartup();

  // 6. Запускаем авто-обновление бинарей yt-dlp и ffmpeg в фоне
  updater = require('./updater');
  updater.checkAndUpdate({ silent: true });

  // 7. Создаём tray (только если есть главное окно)
  // Tray создаётся после routeStartup, потому что при первом запуске
  // главного окна ещё нет — только auth
  setupTray();

  // macOS: при клике на dock icon восстанавливаем окно
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      routeStartup();
    }
  });
});

// Закрытие: на macOS приложение остаётся в dock (стандартное поведение)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// МАРШРУТИЗАЦИЯ ЗАПУСКА
// Определяет какое окно показать при старте приложения
// ─────────────────────────────────────────────────────────────────────────────

async function routeStartup() {
  // Проверяем есть ли хоть один пользователь в БД
  const user = db.getFirstUser();

  if (!user) {
    // ── Первый запуск: показываем регистрацию ──
    await createAuthWindow();
    return;
  }

  // Пользователь есть — проверяем прошёл ли онбординг
  if (!user.onboarding_done) {
    // ── Онбординг ещё не завершён ──
    await createOnboardWindow(user);
    return;
  }

  // ── Всё готово: показываем главный экран ──
  await createMainWindow(user);
}

// ─────────────────────────────────────────────────────────────────────────────
// СОЗДАНИЕ ОКОН
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Базовая конфигурация BrowserWindow — применяется ко всем окнам.
 * Контекстная изоляция и preload обязательны для безопасности.
 */
function getBaseWindowConfig(overrides = {}) {
  return {
    show: false,          // Показываем только после ready-to-show
    frame: false,         // Кастомный titlebar через React
    titleBarStyle: 'hidden',
    backgroundColor: '#0f0f0f', // Совпадает с --bg-primary в тёмной теме
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,   // ОБЯЗАТЕЛЬНО — изолирует renderer от Node
      nodeIntegration: false,   // ОБЯЗАТЕЛЬНО — renderer не видит Node API
      sandbox: false,           // false нужен для preload с require()
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
    icon: getAppIcon(),
    ...overrides,
  };
}

/**
 * Окно регистрации / входа.
 * Маленькое центрированное окно без изменения размера.
 */
async function createAuthWindow() {
  if (authWindow) {
    authWindow.focus();
    return;
  }

  authWindow = new BrowserWindow(
    getBaseWindowConfig({
      ...WINDOW_SIZES.auth,
      center: true,
    })
  );

  // Загружаем страницу
  await loadWindowUrl(authWindow, '/auth');

  authWindow.once('ready-to-show', () => {
    authWindow.show();
    // В dev-режиме открываем DevTools
    if (isDev) authWindow.webContents.openDevTools({ mode: 'detach' });
  });

  authWindow.on('closed', () => {
    authWindow = null;
  });

  // ── IPC: регистрация завершена ──
  // Renderer вызывает этот канал когда пользователь успешно зарегистрировался
  ipcMain.once('auth:registration-complete', async (_, userId) => {
    const user = db.getUserById(userId);
    if (authWindow) authWindow.close();
    await createOnboardWindow(user);
    setupTray(); // Создаём tray теперь когда есть юзер
  });

  // ── IPC: вход завершён (через OAuth) ──
  ipcMain.once('auth:login-complete', async (_, userId) => {
    const user = db.getUserById(userId);
    if (authWindow) authWindow.close();

    if (!user.onboarding_done) {
      await createOnboardWindow(user);
    } else {
      await createMainWindow(user);
    }
    setupTray();
  });
}

/**
 * Окно онбординга (3-4 слайда с туром).
 * Фиксированный размер, без изменения.
 */
async function createOnboardWindow(user) {
  if (onboardWindow) {
    onboardWindow.focus();
    return;
  }

  onboardWindow = new BrowserWindow(
    getBaseWindowConfig({
      ...WINDOW_SIZES.onboard,
      center: true,
    })
  );

  await loadWindowUrl(onboardWindow, '/onboarding');

  onboardWindow.once('ready-to-show', () => {
    onboardWindow.show();
    if (isDev) onboardWindow.webContents.openDevTools({ mode: 'detach' });
  });

  onboardWindow.on('closed', () => {
    onboardWindow = null;
  });

  // ── IPC: онбординг завершён ──
  ipcMain.once('onboard:complete', async (_, userId) => {
    // Помечаем онбординг завершённым в БД
    db.markOnboardingDone(userId);
    const updatedUser = db.getUserById(userId);
    if (onboardWindow) onboardWindow.close();
    await createMainWindow(updatedUser);
  });
}

/**
 * Главное окно приложения.
 * Полноразмерное, с минимальным размером.
 */
async function createMainWindow(user) {
  if (mainWindow) {
    mainWindow.focus();
    return;
  }

  // Восстанавливаем размер и позицию из прошлой сессии
  const savedBounds = store.get('windowBounds');

  mainWindow = new BrowserWindow(
    getBaseWindowConfig({
      ...WINDOW_SIZES.main,
      ...(savedBounds || {}),     // Позиция из прошлой сессии
    })
  );

  await loadWindowUrl(mainWindow, '/');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();

    // Передаём данные пользователя в renderer сразу при открытии
    mainWindow.webContents.send('app:user-data', {
      id:           user.id,
      name:         user.name,
      email:        user.email,
      avatar:       user.avatar_path,
      osUsername:   os.userInfo().username,
    });

    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // Сохраняем размер/позицию при закрытии
  mainWindow.on('close', () => {
    if (!mainWindow.isMaximized() && !mainWindow.isMinimized()) {
      store.set('windowBounds', mainWindow.getBounds());
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Обновляем ссылку в ipc-handlers
  if (ipcHandlers) {
    ipcHandlers.updateMainWindow(mainWindow);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ЗАГРУЗКА URL В ОКНО
// В dev-режиме — Vite dev server, в продакшене — собранный HTML
// ─────────────────────────────────────────────────────────────────────────────

async function loadWindowUrl(win, route = '/') {
  if (isDev) {
    // Dev: загружаем с Vite dev-сервера с нужным роутом
    await win.loadURL(`${DEV_URL}${route}`);
  } else {
    // Prod: загружаем собранный index.html, хэш-роутинг сам откроет нужную страницу
    await win.loadFile(
      path.join(__dirname, '..', 'dist', 'index.html'),
      { hash: route }
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TRAY ИКОНКА
// ─────────────────────────────────────────────────────────────────────────────

function setupTray() {
  // Не создаём повторно
  if (tray) return;

  const iconFile = process.platform === 'win32'
    ? 'tray-icon.ico'
    : process.platform === 'darwin'
      ? 'tray-icon-mac.png'  // macOS: 16x16 или 22x22 Template image
      : 'tray-icon.png';

  const iconFullPath = path.join(ICON_PATH, iconFile);

  // Если иконки нет (первый запуск без assets) — пропускаем
  if (!fs.existsSync(iconFullPath)) return;

  const trayIcon = nativeImage.createFromPath(iconFullPath);
  tray = new Tray(trayIcon);
  tray.setToolTip('YT Downloader');

  updateTrayMenu();

  // Клик по tray — показываем/скрываем главное окно
  tray.on('click', () => {
    const win = mainWindow || authWindow || onboardWindow;
    if (!win) return;

    if (win.isVisible()) {
      win.hide();
    } else {
      win.show();
      win.focus();
    }
  });
}

function updateTrayMenu() {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Показать YT Downloader',
      click: () => {
        const win = mainWindow || authWindow || onboardWindow;
        if (win) { win.show(); win.focus(); }
      },
    },
    { type: 'separator' },
    {
      label: 'Проверить обновления',
      click: () => updater?.checkAndUpdate({ silent: false }),
    },
    { type: 'separator' },
    {
      label: 'Выйти',
      click: () => app.quit(),
    },
  ]);

  tray.setContextMenu(contextMenu);
}

// ─────────────────────────────────────────────────────────────────────────────
// OAUTH CALLBACK ОБРАБОТЧИК
// Вызывается когда браузер редиректит на ytdl://oauth/callback?code=xxx
// ─────────────────────────────────────────────────────────────────────────────

function handleOAuthCallback(deepLinkUrl) {
  try {
    const parsedUrl  = new URL(deepLinkUrl);
    const provider   = parsedUrl.hostname; // 'google' или 'github'
    const code       = parsedUrl.searchParams.get('code');
    const state      = parsedUrl.searchParams.get('state');
    const error      = parsedUrl.searchParams.get('error');

    if (error) {
      // Пользователь отменил авторизацию
      const win = authWindow || mainWindow;
      win?.webContents.send('oauth:error', { provider, error });
      return;
    }

    if (!code) return;

    // Передаём code в renderer — там ipc-handlers.js обменяет его на токен
    const win = authWindow || mainWindow;
    win?.webContents.send('oauth:callback', { provider, code, state });

  } catch (err) {
    console.error('[main] OAuth callback parse error:', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC: УПРАВЛЕНИЕ ОКНОМ (минимизация, разворот, закрытие)
// Кастомный titlebar в React управляет окном через эти каналы
// ─────────────────────────────────────────────────────────────────────────────

ipcMain.on('window:minimize', () => {
  const win = getFocusedWindow();
  win?.minimize();
});

ipcMain.on('window:maximize-toggle', () => {
  const win = getFocusedWindow();
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});

ipcMain.on('window:close', () => {
  const win = getFocusedWindow();
  win?.close();
});

ipcMain.on('window:hide', () => {
  const win = getFocusedWindow();
  win?.hide();
});

// Получить текущее сфокусированное окно
function getFocusedWindow() {
  return (
    BrowserWindow.getFocusedWindow() ||
    mainWindow ||
    authWindow ||
    onboardWindow
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC: СОСТОЯНИЕ ОКНА
// Renderer спрашивает — развёрнуто ли окно (для кнопки maximize)
// ─────────────────────────────────────────────────────────────────────────────

ipcMain.handle('window:is-maximized', () => {
  return getFocusedWindow()?.isMaximized() ?? false;
});

// Уведомляем renderer когда окно разворачивается/сворачивается
// Вешаем слушатели после создания mainWindow
function attachWindowStateListeners(win) {
  win.on('maximize',   () => win.webContents.send('window:state-changed', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('window:state-changed', { maximized: false }));
  win.on('enter-full-screen', () => win.webContents.send('window:state-changed', { fullscreen: true }));
  win.on('leave-full-screen', () => win.webContents.send('window:state-changed', { fullscreen: false }));
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC: ДИАЛОГ ВЫБОРА ПАПКИ СОХРАНЕНИЯ
// ─────────────────────────────────────────────────────────────────────────────

ipcMain.handle('dialog:open-folder', async () => {
  const win = getFocusedWindow();
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Выберите папку для сохранения',
    defaultPath: store.get('downloadPath') || app.getPath('downloads'),
  });

  if (result.canceled || !result.filePaths.length) return null;

  const selectedPath = result.filePaths[0];
  store.set('downloadPath', selectedPath);
  return selectedPath;
});

// ─────────────────────────────────────────────────────────────────────────────
// IPC: СИСТЕМНАЯ ИНФОРМАЦИЯ
// Renderer запрашивает системные данные через contextBridge
// ─────────────────────────────────────────────────────────────────────────────

ipcMain.handle('system:get-info', () => ({
  platform:    process.platform,       // 'win32' | 'darwin' | 'linux'
  arch:        process.arch,
  osUsername:  os.userInfo().username, // Имя пользователя ОС
  homeDir:     os.homedir(),
  appVersion:  app.getVersion(),
  downloadsDir: app.getPath('downloads'),
  userDataDir:  app.getPath('userData'),
}));

// ─────────────────────────────────────────────────────────────────────────────
// IPC: ВЫХОД / СМЕНА ПОЛЬЗОВАТЕЛЯ
// ─────────────────────────────────────────────────────────────────────────────

ipcMain.handle('auth:logout', async () => {
  // Закрываем главное окно и открываем auth
  if (mainWindow) mainWindow.close();
  await createAuthWindow();
});

// ─────────────────────────────────────────────────────────────────────────────
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Возвращает иконку приложения под текущую платформу.
 * Если файла нет — возвращает пустую иконку (не ломает запуск).
 */
function getAppIcon() {
  const iconFiles = {
    win32:  'icon.ico',
    darwin: 'icon.icns',
    linux:  'icon.png',
  };

  const iconFile     = iconFiles[process.platform] || 'icon.png';
  const iconFullPath = path.join(ICON_PATH, iconFile);

  if (fs.existsSync(iconFullPath)) {
    return nativeImage.createFromPath(iconFullPath);
  }

  // Возвращаем пустую иконку если файла нет
  return nativeImage.createEmpty();
}

// ─────────────────────────────────────────────────────────────────────────────
// ЭКСПОРТ (нужен для ipc-handlers чтобы мог управлять окнами)
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  getMainWindow:    () => mainWindow,
  getAuthWindow:    () => authWindow,
  createMainWindow,
  createAuthWindow,
  updateTrayMenu,
};
