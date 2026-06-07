// ─────────────────────────────────────────────────────────────────────────────
// electron/store.js
//
// Обёртка над electron-store для управления настройками приложения.
// Сохраняет в JSON файл в userData директории.
//
// НАСТРОЙКИ:
//   theme              - 'dark' | 'light' | 'system'
//   accentColor        - hex цвет (#6366f1)
//   language           - 'auto' | 'en' | 'ru' | 'uk' | ...
//   downloadPath       - путь для сохранения
//   defaultFormat      - 'mp4', 'webm', 'mp3' и т.д.
//   windowBounds       - размер и позиция окна
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const Store = require('electron-store');
const path  = require('path');
const { app } = require('electron');

class AppStore {
  constructor() {
    // electron-store автоматически хранит в app.getPath('userData')/config.json
    this.store = new Store({
      configName: 'app-settings',
      defaults: this._getDefaults(),
      watch: true,      // Следим за изменениями на диске
      clearInvalidConfig: true,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ЗНАЧЕНИЯ ПО УМОЛЧАНИЮ
  // ─────────────────────────────────────────────────────────────────────────

  _getDefaults() {
    return {
      // ── Внешний вид ───────────────────────────────────────────────────────
      theme:         'dark',
      accentColor:   '#6366f1',    // Indigo
      language:      'auto',       // Определяется из OS

      // ── Папки ─────────────────────────────────────────────────────────────
      downloadPath:  app.getPath('downloads'),

      // ── Форматы по умолчанию ──────────────────────────────────────────────
      defaultFormat:  'mp4',        // Видео
      defaultQuality: 'best',
      defaultFps:     '60',
      defaultBitrate: '320k',       // Аудио

      // ── Поведение ─────────────────────────────────────────────────────────
      concurrentDownloads:  3,
      autoUpdateBinaries:   true,
      minimizeToTray:       true,
      showNotifications:    true,
      showThumbnails:       true,

      // ── Окно ──────────────────────────────────────────────────────────────
      windowBounds: null,           // { x, y, width, height }

      // ── История и кэш ─────────────────────────────────────────────────────
      lastCheckBinariesTime: 0,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ПОЛУЧЕНИЕ/УСТАНОВКА
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Получить значение по ключу.
   * @param {string} key
   * @param {any} defaultValue
   * @returns {any}
   */
  get(key, defaultValue) {
    return this.store.get(key, defaultValue);
  }

  /**
   * Установить значение.
   * @param {string} key
   * @param {any} value
   */
  set(key, value) {
    this.store.set(key, value);
  }

  /**
   * Получить все настройки.
   * @returns {Object}
   */
  getAll() {
    return this.store.store;
  }

  /**
   * Установить несколько настроек.
   * @param {Object} obj
   */
  setAll(obj) {
    this.store.set(obj);
  }

  /**
   * Удалить ключ.
   * @param {string} key
   */
  delete(key) {
    this.store.delete(key);
  }

  /**
   * Проверить есть ли ключ.
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this.store.has(key);
  }

  /**
   * Сбросить все настройки на значения по умолчанию.
   */
  reset() {
    this.store.clear();
    // Заново инициализируем с дефолтами
    const defaults = this._getDefaults();
    for (const [key, value] of Object.entries(defaults)) {
      this.store.set(key, value);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // СПЕЦИФИЧНЫЕ МЕТОДЫ
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Получить тему.
   * @returns {'dark' | 'light' | 'system'}
   */
  getTheme() {
    return this.get('theme', 'dark');
  }

  /**
   * Установить тему.
   */
  setTheme(theme) {
    this.set('theme', theme);
  }

  /**
   * Получить акцентный цвет.
   * @returns {string} hex
   */
  getAccentColor() {
    return this.get('accentColor', '#6366f1');
  }

  /**
   * Установить акцентный цвет.
   */
  setAccentColor(color) {
    // Валидация hex цвета
    if (!/^#[0-9A-F]{6}$/i.test(color)) {
      throw new Error('Неверный hex цвет');
    }
    this.set('accentColor', color);
  }

  /**
   * Получить язык.
   * @returns {string} код языка или 'auto'
   */
  getLanguage() {
    return this.get('language', 'auto');
  }

  /**
   * Установить язык.
   */
  setLanguage(lang) {
    this.set('language', lang);
  }

  /**
   * Получить папку для загрузок.
   * @returns {string}
   */
  getDownloadPath() {
    const path = this.get('downloadPath');
    return path || app.getPath('downloads');
  }

  /**
   * Установить папку для загрузок.
   */
  setDownloadPath(folderPath) {
    this.set('downloadPath', folderPath);
  }

  /**
   * Получить границы окна для восстановления размера/позиции.
   * @returns {null | { x, y, width, height }}
   */
  getWindowBounds() {
    return this.get('windowBounds', null);
  }

  /**
   * Сохранить границы окна.
   */
  setWindowBounds(bounds) {
    this.set('windowBounds', bounds);
  }

  /**
   * Получить параметры загрузки по умолчанию.
   * @returns {{
   *   format, quality, fps, bitrate,
   *   concurrentDownloads, autoUpdateBinaries,
   *   minimizeToTray, showNotifications
   * }}
   */
  getDownloadDefaults() {
    return {
      format:                this.get('defaultFormat', 'mp4'),
      quality:               this.get('defaultQuality', 'best'),
      fps:                   this.get('defaultFps', '60'),
      bitrate:               this.get('defaultBitrate', '320k'),
      concurrentDownloads:   this.get('concurrentDownloads', 3),
      autoUpdateBinaries:    this.get('autoUpdateBinaries', true),
      minimizeToTray:        this.get('minimizeToTray', true),
      showNotifications:     this.get('showNotifications', true),
    };
  }

  /**
   * Установить параметры загрузки.
   */
  setDownloadDefaults(defaults) {
    const { format, quality, fps, bitrate, concurrentDownloads, autoUpdateBinaries, minimizeToTray, showNotifications } = defaults;

    if (format !== undefined) this.set('defaultFormat', format);
    if (quality !== undefined) this.set('defaultQuality', quality);
    if (fps !== undefined) this.set('defaultFps', fps);
    if (bitrate !== undefined) this.set('defaultBitrate', bitrate);
    if (concurrentDownloads !== undefined) this.set('concurrentDownloads', concurrentDownloads);
    if (autoUpdateBinaries !== undefined) this.set('autoUpdateBinaries', autoUpdateBinaries);
    if (minimizeToTray !== undefined) this.set('minimizeToTray', minimizeToTray);
    if (showNotifications !== undefined) this.set('showNotifications', showNotifications);
  }

  /**
   * Получить время последней проверки обновлений бинарей.
   * Используется чтобы не проверять слишком часто.
   * @returns {number} timestamp
   */
  getLastBinariesCheckTime() {
    return this.get('lastCheckBinariesTime', 0);
  }

  /**
   * Сохранить время последней проверки обновлений.
   */
  setLastBinariesCheckTime() {
    this.set('lastCheckBinariesTime', Date.now());
  }

  /**
   * Проверить нужна ли проверка обновлений.
   * Проверяем раз в сутки.
   * @returns {boolean}
   */
  shouldCheckBinariesUpdate() {
    const lastCheck = this.getLastBinariesCheckTime();
    const dayInMs = 24 * 60 * 60 * 1000;
    return Date.now() - lastCheck > dayInMs;
  }

  /**
   * Получить файл конфига для отладки.
   * @returns {string} путь к файлу
   */
  getConfigPath() {
    return path.join(app.getPath('userData'), 'app-settings.json');
  }
}

module.exports = AppStore;
