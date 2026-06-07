// ─────────────────────────────────────────────────────────────────────────────
// electron/database.js
//
// SQLite обёртка через better-sqlite3.
//
// ПОЧЕМУ better-sqlite3, а не node-sqlite3?
//   — Синхронное API (нет callback hell)
//   — В 2-3 раза быстрее для десктоп-приложений
//   — Поддерживает prepared statements из коробки
//   — Отлично работает с Electron
//
// ТАБЛИЦЫ:
//   users          — профили пользователей (локальный + OAuth)
//   oauth_tokens   — токены Google/GitHub
//   downloads      — история загрузок
//   settings       — настройки приложения (key-value)
//
// ФАЙЛ БД хранится в: app.getPath('userData')/ytdownloader.db
//   Windows: C:\Users\<user>\AppData\Roaming\yt-downloader\
//   macOS:   ~/Library/Application Support/yt-downloader/
//   Linux:   ~/.config/yt-downloader/
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const { app }  = require('electron');

class AppDatabase {
  constructor() {
    this.db = null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ИНИЦИАЛИЗАЦИЯ
  // ─────────────────────────────────────────────────────────────────────────

  initialize() {
    const dbPath = path.join(app.getPath('userData'), 'ytdownloader.db');

    // verbose: в dev-режиме логируем все SQL запросы
    this.db = new Database(dbPath, {
      verbose: process.env.NODE_ENV === 'development'
        ? (sql) => console.log('[SQL]', sql)
        : null,
    });

    // WAL режим — значительно ускоряет запись, безопасен для десктопа
    this.db.pragma('journal_mode = WAL');

    // Включаем foreign keys (по умолчанию в SQLite отключены)
    this.db.pragma('foreign_keys = ON');

    // Создаём таблицы
    this._createTables();

    // Заполняем настройки по умолчанию (только если их ещё нет)
    this._seedDefaultSettings();

    console.log('[database] Инициализирован:', dbPath);
    return this;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // СОЗДАНИЕ ТАБЛИЦ
  // ─────────────────────────────────────────────────────────────────────────

  _createTables() {
    // Выполняем всё в одной транзакции для скорости и атомарности
    const createAll = this.db.transaction(() => {

      // ── Таблица пользователей ───────────────────────────────────────────
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id                TEXT PRIMARY KEY,    -- UUID v4
          name              TEXT NOT NULL,
          email             TEXT UNIQUE,         -- NULL для OAuth без email
          password_hash     TEXT,                -- NULL для OAuth пользователей
          avatar_path       TEXT,                -- Относительный путь: avatars/uuid.jpg
          auth_provider     TEXT NOT NULL DEFAULT 'local',
                                                 -- 'local' | 'google' | 'github'
          provider_id       TEXT,                -- ID в Google/GitHub
          onboarding_done   INTEGER NOT NULL DEFAULT 0,  -- 0 = false, 1 = true
          created_at        TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at        TEXT NOT NULL DEFAULT (datetime('now')),

          -- Если auth_provider = 'local', нужен пароль
          -- Если auth_provider != 'local', нужен provider_id
          CHECK (
            (auth_provider = 'local' AND password_hash IS NOT NULL)
            OR
            (auth_provider != 'local' AND provider_id IS NOT NULL)
          )
        )
      `);

      // ── OAuth токены ────────────────────────────────────────────────────
      // Хранятся отдельно по соображениям безопасности
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS oauth_tokens (
          id            TEXT PRIMARY KEY,
          user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          provider      TEXT NOT NULL,           -- 'google' | 'github'
          access_token  TEXT NOT NULL,
          refresh_token TEXT,
          expires_at    TEXT,                    -- ISO 8601
          scope         TEXT,
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at    TEXT NOT NULL DEFAULT (datetime('now')),

          UNIQUE(user_id, provider)
        )
      `);

      // ── История загрузок ────────────────────────────────────────────────
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS downloads (
          id              TEXT PRIMARY KEY,      -- UUID генерируется в downloader.js
          user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
          url             TEXT NOT NULL,         -- Исходная ссылка
          title           TEXT,                  -- Название видео/трека
          thumbnail       TEXT,                  -- URL превью
          type            TEXT NOT NULL,         -- 'video' | 'audio' | 'playlist-video' | 'playlist-audio'
          format          TEXT,                  -- 'mp4' | 'webm' | 'mp3' | 'aac' | ...
          quality         TEXT,                  -- '4K' | '1080p' | '720p' | '480p' | '360p' | 'best'
          fps             INTEGER,               -- 24 | 30 | 60 | NULL для аудио
          bitrate         TEXT,                  -- '320k' | '256k' | '192k' | '128k' | NULL для видео
          file_path       TEXT,                  -- Полный путь к сохранённому файлу
          file_size       INTEGER,               -- Байты
          duration        INTEGER,               -- Секунды
          status          TEXT NOT NULL DEFAULT 'pending',
                                                 -- 'pending' | 'downloading' | 'paused' |
                                                 -- 'completed' | 'failed' | 'cancelled'
          progress        REAL DEFAULT 0,        -- 0.0 – 100.0
          error_message   TEXT,                  -- Сообщение об ошибке если status='failed'
          site            TEXT,                  -- 'youtube' | 'instagram' | 'tiktok' | ...
          playlist_id     TEXT,                  -- ID плейлиста если это трек из плейлиста
          playlist_index  INTEGER,               -- Порядковый номер в плейлисте
          started_at      TEXT,                  -- Когда началась загрузка
          completed_at    TEXT,                  -- Когда завершилась
          created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);

      // Индексы для быстрого поиска в истории
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_downloads_user_id
          ON downloads(user_id);

        CREATE INDEX IF NOT EXISTS idx_downloads_status
          ON downloads(status);

        CREATE INDEX IF NOT EXISTS idx_downloads_created_at
          ON downloads(created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_downloads_playlist_id
          ON downloads(playlist_id);
      `);

      // ── Настройки приложения (key-value store) ──────────────────────────
      // Используем SQLite вместо electron-store для атомарности с БД
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key         TEXT PRIMARY KEY,
          value       TEXT NOT NULL,             -- Всегда JSON stringify
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);

      // ── Сессия (текущий залогиненный пользователь) ──────────────────────
      // Простая таблица из одной строки
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS session (
          id          INTEGER PRIMARY KEY CHECK (id = 1),  -- Только одна строка
          user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
          logged_in_at TEXT DEFAULT (datetime('now'))
        )
      `);

    }); // конец транзакции

    createAll();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // НАСТРОЙКИ ПО УМОЛЧАНИЮ
  // ─────────────────────────────────────────────────────────────────────────

  _seedDefaultSettings() {
    const defaults = {
      theme:                'dark',        // 'dark' | 'light' | 'system'
      accentColor:          '#6366f1',     // Indigo по умолчанию
      language:             'auto',        // 'auto' = определить из системы
      downloadPath:         '',            // '' = папка Downloads
      defaultFormat:        'mp4',
      defaultQuality:       'best',
      defaultFps:           '60',
      defaultBitrate:       '320k',
      concurrentDownloads:  '3',
      autoUpdateBinaries:   'true',
      notifications:        'true',
      minimizeToTray:       'true',
      showThumbnails:       'true',
    };

    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO settings (key, value)
      VALUES (@key, @value)
    `);

    const insertAll = this.db.transaction((items) => {
      for (const [key, value] of items) {
        insert.run({ key, value: JSON.stringify(value) });
      }
    });

    insertAll(Object.entries(defaults));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // МЕТОДЫ: ПОЛЬЗОВАТЕЛИ
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Создать нового пользователя.
   * @param {{
   *   id, name, email, passwordHash?,
   *   avatarPath?, authProvider, providerId?
   * }} userData
   * @returns {User}
   */
  createUser(userData) {
    const stmt = this.db.prepare(`
      INSERT INTO users
        (id, name, email, password_hash, avatar_path, auth_provider, provider_id)
      VALUES
        (@id, @name, @email, @passwordHash, @avatarPath, @authProvider, @providerId)
    `);

    stmt.run({
      id:           userData.id,
      name:         userData.name,
      email:        userData.email        ?? null,
      passwordHash: userData.passwordHash ?? null,
      avatarPath:   userData.avatarPath   ?? null,
      authProvider: userData.authProvider ?? 'local',
      providerId:   userData.providerId   ?? null,
    });

    return this.getUserById(userData.id);
  }

  /**
   * Получить первого (и обычно единственного) пользователя.
   * Используется в routeStartup() для определения маршрута.
   * @returns {User | null}
   */
  getFirstUser() {
    return this.db
      .prepare('SELECT * FROM users ORDER BY created_at ASC LIMIT 1')
      .get() ?? null;
  }

  /**
   * Получить пользователя по ID.
   * @param {string} id
   * @returns {User | null}
   */
  getUserById(id) {
    return this.db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(id) ?? null;
  }

  /**
   * Получить пользователя по email.
   * @param {string} email
   * @returns {User | null}
   */
  getUserByEmail(email) {
    return this.db
      .prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE')
      .get(email) ?? null;
  }

  /**
   * Найти пользователя по OAuth provider + provider_id.
   * @param {'google' | 'github'} provider
   * @param {string} providerId
   * @returns {User | null}
   */
  getUserByProvider(provider, providerId) {
    return this.db
      .prepare('SELECT * FROM users WHERE auth_provider = ? AND provider_id = ?')
      .get(provider, providerId) ?? null;
  }

  /**
   * Обновить профиль пользователя.
   * @param {string} id
   * @param {{ name?, email?, avatarPath?, passwordHash? }} updates
   * @returns {User}
   */
  updateUser(id, updates) {
    const fields = [];
    const values = {};

    if (updates.name !== undefined) {
      fields.push('name = @name');
      values.name = updates.name;
    }
    if (updates.email !== undefined) {
      fields.push('email = @email');
      values.email = updates.email;
    }
    if (updates.avatarPath !== undefined) {
      fields.push('avatar_path = @avatarPath');
      values.avatarPath = updates.avatarPath;
    }
    if (updates.passwordHash !== undefined) {
      fields.push('password_hash = @passwordHash');
      values.passwordHash = updates.passwordHash;
    }

    if (fields.length === 0) return this.getUserById(id);

    fields.push("updated_at = datetime('now')");
    values.id = id;

    this.db
      .prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = @id`)
      .run(values);

    return this.getUserById(id);
  }

  /**
   * Пометить онбординг завершённым.
   * @param {string} userId
   */
  markOnboardingDone(userId) {
    this.db
      .prepare("UPDATE users SET onboarding_done = 1, updated_at = datetime('now') WHERE id = ?")
      .run(userId);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // МЕТОДЫ: OAuth ТОКЕНЫ
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Сохранить/обновить OAuth токен.
   * @param {{
   *   id, userId, provider,
   *   accessToken, refreshToken?, expiresAt?, scope?
   * }} tokenData
   */
  upsertOAuthToken(tokenData) {
    this.db.prepare(`
      INSERT INTO oauth_tokens
        (id, user_id, provider, access_token, refresh_token, expires_at, scope)
      VALUES
        (@id, @userId, @provider, @accessToken, @refreshToken, @expiresAt, @scope)
      ON CONFLICT(user_id, provider) DO UPDATE SET
        access_token  = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at    = excluded.expires_at,
        scope         = excluded.scope,
        updated_at    = datetime('now')
    `).run({
      id:           tokenData.id,
      userId:       tokenData.userId,
      provider:     tokenData.provider,
      accessToken:  tokenData.accessToken,
      refreshToken: tokenData.refreshToken ?? null,
      expiresAt:    tokenData.expiresAt    ?? null,
      scope:        tokenData.scope        ?? null,
    });
  }

  /**
   * Получить OAuth токен пользователя.
   * @param {string} userId
   * @param {'google' | 'github'} provider
   * @returns {OAuthToken | null}
   */
  getOAuthToken(userId, provider) {
    return this.db
      .prepare('SELECT * FROM oauth_tokens WHERE user_id = ? AND provider = ?')
      .get(userId, provider) ?? null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // МЕТОДЫ: ЗАГРУЗКИ
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Создать запись о загрузке.
   * @param {{
   *   id, userId, url, title?, thumbnail?,
   *   type, format?, quality?, fps?, bitrate?,
   *   duration?, site?, playlistId?, playlistIndex?
   * }} downloadData
   * @returns {Download}
   */
  createDownload(downloadData) {
    this.db.prepare(`
      INSERT INTO downloads
        (id, user_id, url, title, thumbnail, type, format, quality,
         fps, bitrate, duration, site, playlist_id, playlist_index, started_at)
      VALUES
        (@id, @userId, @url, @title, @thumbnail, @type, @format, @quality,
         @fps, @bitrate, @duration, @site, @playlistId, @playlistIndex, datetime('now'))
    `).run({
      id:            downloadData.id,
      userId:        downloadData.userId        ?? null,
      url:           downloadData.url,
      title:         downloadData.title         ?? null,
      thumbnail:     downloadData.thumbnail     ?? null,
      type:          downloadData.type,
      format:        downloadData.format        ?? null,
      quality:       downloadData.quality       ?? null,
      fps:           downloadData.fps           ?? null,
      bitrate:       downloadData.bitrate       ?? null,
      duration:      downloadData.duration      ?? null,
      site:          downloadData.site          ?? null,
      playlistId:    downloadData.playlistId    ?? null,
      playlistIndex: downloadData.playlistIndex ?? null,
    });

    return this.getDownloadById(downloadData.id);
  }

  /**
   * Получить загрузку по ID.
   * @param {string} id
   * @returns {Download | null}
   */
  getDownloadById(id) {
    return this.db
      .prepare('SELECT * FROM downloads WHERE id = ?')
      .get(id) ?? null;
  }

  /**
   * Обновить статус и прогресс загрузки.
   * @param {string} id
   * @param {{ status?, progress?, filePath?, fileSize?, errorMessage? }} updates
   */
  updateDownload(id, updates) {
    const fields = ["updated_at = datetime('now')"];
    const values = { id };

    if (updates.status !== undefined) {
      fields.push('status = @status');
      values.status = updates.status;

      if (updates.status === 'completed') {
        fields.push("completed_at = datetime('now')");
      }
    }
    if (updates.progress !== undefined) {
      fields.push('progress = @progress');
      values.progress = updates.progress;
    }
    if (updates.filePath !== undefined) {
      fields.push('file_path = @filePath');
      values.filePath = updates.filePath;
    }
    if (updates.fileSize !== undefined) {
      fields.push('file_size = @fileSize');
      values.fileSize = updates.fileSize;
    }
    if (updates.errorMessage !== undefined) {
      fields.push('error_message = @errorMessage');
      values.errorMessage = updates.errorMessage;
    }
    if (updates.title !== undefined) {
      fields.push('title = @title');
      values.title = updates.title;
    }
    if (updates.thumbnail !== undefined) {
      fields.push('thumbnail = @thumbnail');
      values.thumbnail = updates.thumbnail;
    }

    this.db
      .prepare(`UPDATE downloads SET ${fields.join(', ')} WHERE id = @id`)
      .run(values);
  }

  /**
   * Получить историю загрузок с пагинацией и поиском.
   * @param {{
   *   userId?: string,
   *   limit?: number,
   *   offset?: number,
   *   search?: string,
   *   status?: string,
   *   type?: string
   * }} options
   * @returns {{ items: Download[], total: number }}
   */
  getDownloads(options = {}) {
    const {
      userId,
      limit  = 50,
      offset = 0,
      search,
      status,
      type,
    } = options;

    const conditions = [];
    const params     = {};

    if (userId) {
      conditions.push('user_id = @userId');
      params.userId = userId;
    }
    if (status) {
      conditions.push('status = @status');
      params.status = status;
    }
    if (type) {
      conditions.push('type = @type');
      params.type = type;
    }
    if (search) {
      conditions.push('(title LIKE @search OR url LIKE @search)');
      params.search = `%${search}%`;
    }

    const where = conditions.length
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    const items = this.db
      .prepare(`
        SELECT * FROM downloads
        ${where}
        ORDER BY created_at DESC
        LIMIT @limit OFFSET @offset
      `)
      .all({ ...params, limit, offset });

    const { total } = this.db
      .prepare(`SELECT COUNT(*) as total FROM downloads ${where}`)
      .get(params);

    return { items, total };
  }

  /**
   * Удалить загрузку из истории.
   * @param {string} id
   * @returns {Download} — запись до удаления (нужна для удаления файла)
   */
  deleteDownload(id) {
    const record = this.getDownloadById(id);
    this.db.prepare('DELETE FROM downloads WHERE id = ?').run(id);
    return record;
  }

  /**
   * Удалить все загрузки пользователя.
   * @param {string} userId
   * @returns {Download[]} — все записи до удаления
   */
  clearDownloads(userId) {
    const records = this.db
      .prepare('SELECT * FROM downloads WHERE user_id = ?')
      .all(userId);

    this.db
      .prepare('DELETE FROM downloads WHERE user_id = ?')
      .run(userId);

    return records;
  }

  /**
   * Получить активные загрузки (для восстановления после перезапуска).
   * downloading + paused — их нужно пометить как failed при старте
   * @returns {Download[]}
   */
  getActiveDownloads() {
    return this.db
      .prepare("SELECT * FROM downloads WHERE status IN ('downloading', 'paused')")
      .all();
  }

  /**
   * Пометить все "зависшие" загрузки как failed.
   * Вызывается при старте приложения.
   */
  resetStaleDownloads() {
    this.db.prepare(`
      UPDATE downloads
      SET status = 'failed',
          error_message = 'Прервано: приложение было закрыто во время загрузки'
      WHERE status IN ('downloading', 'paused')
    `).run();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // МЕТОДЫ: НАСТРОЙКИ
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Получить все настройки как объект.
   * @returns {Record<string, any>}
   */
  getAllSettings() {
    const rows = this.db
      .prepare('SELECT key, value FROM settings')
      .all();

    return rows.reduce((acc, { key, value }) => {
      try {
        acc[key] = JSON.parse(value);
      } catch {
        acc[key] = value;
      }
      return acc;
    }, {});
  }

  /**
   * Получить одну настройку.
   * @param {string} key
   * @returns {any}
   */
  getSetting(key) {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key);

    if (!row) return null;

    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }

  /**
   * Установить одну или несколько настроек.
   * @param {Record<string, any>} updates
   */
  setSettings(updates) {
    const upsert = this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (@key, @value, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value      = excluded.value,
        updated_at = excluded.updated_at
    `);

    const upsertAll = this.db.transaction((items) => {
      for (const [key, value] of items) {
        upsert.run({ key, value: JSON.stringify(value) });
      }
    });

    upsertAll(Object.entries(updates));
  }

  /**
   * Сбросить настройки к дефолтным.
   */
  resetSettings() {
    this.db.prepare('DELETE FROM settings').run();
    this._seedDefaultSettings();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // МЕТОДЫ: СЕССИЯ
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Сохранить текущего пользователя в сессию.
   * @param {string} userId
   */
  setSession(userId) {
    this.db.prepare(`
      INSERT INTO session (id, user_id, logged_in_at)
      VALUES (1, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        user_id     = excluded.user_id,
        logged_in_at = excluded.logged_in_at
    `).run(userId);
  }

  /**
   * Получить текущего пользователя из сессии.
   * @returns {User | null}
   */
  getSessionUser() {
    const session = this.db
      .prepare('SELECT user_id FROM session WHERE id = 1')
      .get();

    if (!session?.user_id) return null;
    return this.getUserById(session.user_id);
  }

  /**
   * Очистить сессию (выход).
   */
  clearSession() {
    this.db
      .prepare('UPDATE session SET user_id = NULL WHERE id = 1')
      .run();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // СТАТИСТИКА (для главного экрана)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Получить статистику загрузок пользователя.
   * @param {string} userId
   * @returns {{
   *   totalDownloads, completedDownloads, totalBytes,
   *   videosCount, audioCount, todayCount
   * }}
   */
  getUserStats(userId) {
    return this.db.prepare(`
      SELECT
        COUNT(*)                                          AS totalDownloads,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completedDownloads,
        SUM(CASE WHEN status = 'completed' THEN file_size ELSE 0 END) AS totalBytes,
        SUM(CASE WHEN type LIKE '%video%' AND status = 'completed' THEN 1 ELSE 0 END) AS videosCount,
        SUM(CASE WHEN type LIKE '%audio%' AND status = 'completed' THEN 1 ELSE 0 END) AS audioCount,
        SUM(CASE WHEN date(created_at) = date('now') THEN 1 ELSE 0 END) AS todayCount
      FROM downloads
      WHERE user_id = ?
    `).get(userId) ?? {
      totalDownloads: 0, completedDownloads: 0,
      totalBytes: 0, videosCount: 0, audioCount: 0, todayCount: 0,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // УТИЛИТЫ
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Закрыть соединение с БД (вызывается при выходе из приложения).
   */
  close() {
    if (this.db) {
      this.db.close();
      console.log('[database] Соединение закрыто');
    }
  }
}

// Закрываем БД при выходе из приложения
const { app: electronApp } = require('electron');
electronApp.on('before-quit', () => {
  // db экземпляр доступен только если он был создан
  // Поэтому закрытие инициирует ipc-handlers через module.exports
});

module.exports = AppDatabase;
