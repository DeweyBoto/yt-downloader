// ─────────────────────────────────────────────────────────────────────────────
// electron/updater.js
//
// Скачивание и обновление бинарей yt-dlp и ffmpeg.
//
// ЛОГИКА:
//   1. При первом запуске приложения скачиваем обе программы
//   2. Периодически проверяем новые версии в фоне
//   3. Если есть обновление — скачиваем и заменяем старые версии
//   4. Отправляем прогресс в renderer через IPC
//
// ОТКУДА СКАЧИВАЕМ:
//   yt-dlp:  https://github.com/yt-dlp/yt-dlp/releases
//   ffmpeg:  https://www.ffmpeg.org/download.html (или через github)
//
// ГДЕ ХРАНИМ:
//   /app-data/binaries/yt-dlp (или yt-dlp.exe на Windows)
//   /app-data/binaries/ffmpeg (или ffmpeg.exe на Windows)
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const axios    = require('axios');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const { app }  = require('electron');
const { spawn } = require('child_process');
const stream   = require('stream');
const zlib     = require('zlib');

// Таймауты
const DOWNLOAD_TIMEOUT = 120000; // 2 минуты
const CHECK_INTERVAL   = 24 * 60 * 60 * 1000; // 1 день

// ─── Пути ─────────────────────────────────────────────────────────────────────
const BINARIES_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'binaries')
  : path.join(__dirname, '..', 'binaries');

const YT_DLP_NAME  = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const FFMPEG_NAME  = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

const YT_DLP_PATH  = path.join(BINARIES_DIR, YT_DLP_NAME);
const FFMPEG_PATH  = path.join(BINARIES_DIR, FFMPEG_NAME);

// ─── Кэш версий (чтобы не дергать API слишком часто) ────────────────────────
let cachedVersions = null;
let lastCheckTime = 0;

// ─────────────────────────────────────────────────────────────────────────────
// ОСНОВНАЯ ФУНКЦИЯ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Проверить и скачать обновления бинарей.
 * @param {{
 *   silent?: boolean,
 *   onProgress?: (data) => void,
 *   onDone?: (data) => void
 * }} options
 */
async function checkAndUpdate(options = {}) {
  const { silent = true, onProgress, onDone } = options;

  try {
    // Создаём папку binaries если нет
    if (!fs.existsSync(BINARIES_DIR)) {
      fs.mkdirSync(BINARIES_DIR, { recursive: true });
    }

    // Получаем текущие версии бинарей
    const currentVersions = await getCurrentVersions();

    // Получаем последние доступные версии
    const latestVersions = await getLatestVersions();

    // Проверяем есть ли обновления
    const ytDlpNeedsUpdate = !currentVersions.ytdlp ||
      compareVersions(latestVersions.ytdlp, currentVersions.ytdlp) > 0;

    const ffmpegNeedsUpdate = !currentVersions.ffmpeg ||
      compareVersions(latestVersions.ffmpeg, currentVersions.ffmpeg) > 0;

    if (!ytDlpNeedsUpdate && !ffmpegNeedsUpdate) {
      if (!silent) {
        onDone?.({ status: 'up-to-date', ytdlp: currentVersions.ytdlp, ffmpeg: currentVersions.ffmpeg });
      }
      return currentVersions;
    }

    if (!silent) {
      onProgress?.({ status: 'checking', message: 'Проверка обновлений...' });
    }

    // Скачиваем нужные бинари
    if (ytDlpNeedsUpdate) {
      await downloadYtDlp(latestVersions.ytdlp, onProgress);
    }

    if (ffmpegNeedsUpdate) {
      await downloadFFmpeg(latestVersions.ffmpeg, onProgress);
    }

    const updatedVersions = await getCurrentVersions();

    onDone?.({ status: 'completed', ...updatedVersions });
    return updatedVersions;

  } catch (err) {
    console.error('[updater]', err);
    onProgress?.({ status: 'error', error: err.message });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ПОЛУЧЕНИЕ ВЕРСИЙ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Получить текущие версии установленных бинарей.
 */
async function getCurrentVersions() {
  const versions = { ytdlp: null, ffmpeg: null };

  // yt-dlp
  try {
    if (fs.existsSync(YT_DLP_PATH)) {
      const version = await getYtDlpVersion();
      versions.ytdlp = version;
    }
  } catch (err) {
    console.warn('[getCurrentVersions] yt-dlp version error:', err.message);
  }

  // ffmpeg
  try {
    if (fs.existsSync(FFMPEG_PATH)) {
      const version = await getFFmpegVersion();
      versions.ffmpeg = version;
    }
  } catch (err) {
    console.warn('[getCurrentVersions] ffmpeg version error:', err.message);
  }

  return versions;
}

/**
 * Запросить версию yt-dlp путём запуска команды.
 */
function getYtDlpVersion() {
  return new Promise((resolve, reject) => {
    const proc = spawn(YT_DLP_PATH, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });

    let stdout = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString().trim();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        // Версия обычно выглядит как "2023.12.30"
        const match = stdout.match(/[\d.]+/);
        resolve(match ? match[0] : 'unknown');
      } else {
        reject(new Error('Version check failed'));
      }
    });

    proc.on('error', reject);
  });
}

/**
 * Запросить версию ffmpeg.
 */
function getFFmpegVersion() {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, ['-version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });

    let stdout = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        // Парсим версию (обычно в первой строке)
        // ffmpeg version N-XXXXX
        const match = stdout.match(/ffmpeg version ([\d.N-]+)/i);
        resolve(match ? match[1] : 'unknown');
      } else {
        reject(new Error('Version check failed'));
      }
    });

    proc.on('error', reject);
  });
}

/**
 * Получить последние доступные версии с GitHub.
 * Кэшируем результат на 1 час чтобы не дергать API слишком часто.
 */
async function getLatestVersions() {
  if (cachedVersions && Date.now() - lastCheckTime < 60 * 60 * 1000) {
    return cachedVersions;
  }

  try {
    // Получаем последний release yt-dlp
    const ytDlpResp = await axios.get(
      'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest',
      { timeout: 10000 }
    );

    const ytDlpVersion = ytDlpResp.data.tag_name?.replace(/^v/, '') || 'unknown';

    // FFmpeg тоже на GitHub (ffmpeg-build)
    // Или используем статическое значение последней стабильной версии
    const ffmpegVersion = await getLatestFFmpegVersion();

    cachedVersions = {
      ytdlp:  ytDlpVersion,
      ffmpeg: ffmpegVersion,
    };

    lastCheckTime = Date.now();
    return cachedVersions;

  } catch (err) {
    console.warn('[getLatestVersions]', err.message);
    // Если ошибка — возвращаем текущие версии
    return await getCurrentVersions();
  }
}

/**
 * Получить последнюю версию ffmpeg.
 * FFmpeg обновляется реже, поэтому используем известные версии.
 */
async function getLatestFFmpegVersion() {
  try {
    // Если есть интернет — пытаемся получить с BtbN GitHub
    // https://github.com/BtbN/FFmpeg-Builds/releases
    const resp = await axios.get(
      'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases?per_page=1',
      { timeout: 10000 }
    );

    if (Array.isArray(resp.data) && resp.data.length > 0) {
      return resp.data[0].tag_name?.replace(/^auto-git-/, '') || '7.0';
    }

    return '7.0'; // Fallback версия
  } catch {
    return '7.0';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// СКАЧИВАНИЕ БИНАРЕЙ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Скачать и установить yt-dlp.
 */
async function downloadYtDlp(version, onProgress) {
  return new Promise(async (resolve, reject) => {
    try {
      onProgress?.({
        binary: 'yt-dlp',
        status: 'downloading',
        version,
        percent: 0,
        message: `Скачивание yt-dlp ${version}...`,
      });

      // URL для скачивания зависит от платформы
      const downloadUrl = getYtDlpDownloadUrl(version);
      const tempPath = path.join(BINARIES_DIR, YT_DLP_NAME + '.tmp');

      // Скачиваем с прогрессом
      await downloadFile(downloadUrl, tempPath, (percent) => {
        onProgress?.({
          binary: 'yt-dlp',
          status: 'downloading',
          percent,
          message: `Скачивание yt-dlp... ${percent}%`,
        });
      });

      // Делаем исполняемым на Unix
      if (process.platform !== 'win32') {
        fs.chmodSync(tempPath, 0o755);
      }

      // Заменяем старую версию
      if (fs.existsSync(YT_DLP_PATH)) {
        fs.unlinkSync(YT_DLP_PATH);
      }
      fs.renameSync(tempPath, YT_DLP_PATH);

      onProgress?.({
        binary: 'yt-dlp',
        status: 'completed',
        version,
        message: `yt-dlp ${version} установлен ✓`,
      });

      resolve();

    } catch (err) {
      console.error('[downloadYtDlp]', err);
      reject(err);
    }
  });
}

/**
 * Скачать и установить ffmpeg.
 */
async function downloadFFmpeg(version, onProgress) {
  return new Promise(async (resolve, reject) => {
    try {
      onProgress?.({
        binary: 'ffmpeg',
        status: 'downloading',
        version,
        percent: 0,
        message: `Скачивание ffmpeg ${version}...`,
      });

      const downloadUrl = getFFmpegDownloadUrl(version);
      const tempPath = path.join(BINARIES_DIR, FFMPEG_NAME + '.tmp');

      await downloadFile(downloadUrl, tempPath, (percent) => {
        onProgress?.({
          binary: 'ffmpeg',
          status: 'downloading',
          percent,
          message: `Скачивание ffmpeg... ${percent}%`,
        });
      });

      if (process.platform !== 'win32') {
        fs.chmodSync(tempPath, 0o755);
      }

      if (fs.existsSync(FFMPEG_PATH)) {
        fs.unlinkSync(FFMPEG_PATH);
      }
      fs.renameSync(tempPath, FFMPEG_PATH);

      onProgress?.({
        binary: 'ffmpeg',
        status: 'completed',
        version,
        message: `ffmpeg ${version} установлен ✓`,
      });

      resolve();

    } catch (err) {
      console.error('[downloadFFmpeg]', err);
      reject(err);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// УТИЛИТЫ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Получить URL скачивания yt-dlp для текущей платформы.
 */
function getYtDlpDownloadUrl(version) {
  const base = 'https://github.com/yt-dlp/yt-dlp/releases/download/';
  const tag = version.startsWith('v') ? version : `${version}`;

  if (process.platform === 'win32') {
    return `${base}${tag}/yt-dlp.exe`;
  } else if (process.platform === 'darwin') {
    // macOS universal binary
    return `${base}${tag}/yt-dlp_macos`;
  } else {
    // Linux
    return `${base}${tag}/yt-dlp`;
  }
}

/**
 * Получить URL скачивания ffmpeg.
 */
function getFFmpegDownloadUrl(version) {
  const base = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/';

  if (process.platform === 'win32') {
    return `${base}${version}/ffmpeg-${version}-full_build.zip`;
  } else if (process.platform === 'darwin') {
    return `${base}${version}/ffmpeg-${version}-macos64-gpl.zip`;
  } else {
    return `${base}${version}/ffmpeg-${version}-linux64-gpl.tar.xz`;
  }
}

/**
 * Скачать файл с отслеживанием прогресса.
 */
function downloadFile(url, outputPath, onProgress) {
  return new Promise(async (resolve, reject) => {
    try {
      const response = await axios({
        method: 'get',
        url,
        responseType: 'stream',
        timeout: DOWNLOAD_TIMEOUT,
      });

      const totalSize = parseInt(response.headers['content-length'], 10);
      let downloadedSize = 0;

      const writeStream = fs.createWriteStream(outputPath);

      response.data.on('data', (chunk) => {
        downloadedSize += chunk.length;
        const percent = Math.round((downloadedSize / totalSize) * 100);
        onProgress?.(percent);
      });

      response.data.pipe(writeStream);

      writeStream.on('finish', resolve);
      writeStream.on('error', reject);

    } catch (err) {
      // Пытаемся удалить неполный файл
      try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
      reject(err);
    }
  });
}

/**
 * Сравнение версий (простое).
 * Возвращает: < 0 if v1 < v2, 0 if v1 = v2, > 0 if v1 > v2
 */
function compareVersions(v1, v2) {
  if (!v1 || !v2) return 0;

  const parts1 = v1.split('.').map(p => parseInt(p) || 0);
  const parts2 = v2.split('.').map(p => parseInt(p) || 0);

  const length = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < length; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;

    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }

  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// ЭКСПОРТ
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  checkAndUpdate,
  getCurrentVersions,
  getLatestVersions,
};
