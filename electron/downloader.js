// ─────────────────────────────────────────────────────────────────────────────
// electron/downloader.js
//
// Управление загрузками через yt-dlp.
//
// АРХИТЕКТУРА:
//   getMediaInfo()      — получить информацию о видео/плейлисте (форматы, качество)
//   startDownload()     — запустить загрузку (spawn yt-dlp процесс)
//   pauseDownload()     — поставить на паузу (SIGSTOP)
//   resumeDownload()    — возобновить (SIGCONT)
//   cancelDownload()    — отменить (SIGKILL)
//
// ПАРСИНГ ПРОГРЕССА:
//   yt-dlp пишет в stdout строки вроде:
//   [download] 45.2% of ~123.45MiB at 2.34MiB/s ETA 00:45
//   Мы парсим эти строки в реальном времени и отправляем в React.
//
// ОЧЕРЕДЬ:
//   Если это плейлист — каждый трек/видео запускается отдельным процессом.
//   Ограничиваем количество одновременных загрузок (по настройкам, по умолчанию 3).
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { spawn }  = require('child_process');
const path       = require('path');
const os         = require('os');
const fs         = require('fs');
const { app }    = require('electron');
const prettyBytes = require('pretty-bytes');

// ─── Пути к бинариям ─────────────────────────────────────────────────────────
// Они скачиваются в папку binaries/ при первом запуске (updater.js)
// В dev-режиме ищем в binaries/, в продакшене в ресурсах приложения

const getBinaryPath = (binary) => {
  const binDir = app.isPackaged
    ? path.join(process.resourcesPath, 'binaries')
    : path.join(__dirname, '..', 'binaries');

  const exeName = process.platform === 'win32' ? `${binary}.exe` : binary;
  return path.join(binDir, exeName);
};

const YT_DLP_PATH  = getBinaryPath('yt-dlp');
const FFMPEG_PATH  = getBinaryPath('ffmpeg');

// ─── Хранилище активных процессов ────────────────────────────────────────────
// { downloadId: { process, paused, filePath } }
const activeDownloads = new Map();

// Очередь плейлистов
// { playlistUrl: { total, completed, downloadIds } }
const playlistQueues = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// ПОЛУЧЕНИЕ ИНФОРМАЦИИ О МЕДИА
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Получить информацию о видео/плейлисте через yt-dlp.
 * Используется перед загрузкой чтобы показать качество, длину, форматы.
 *
 * @param {string} url
 * @returns {Promise<{
 *   title, thumbnail, duration, isPlaylist, playlistLength,
 *   formats: { format, ext, resolution, fps, vcodec, acodec, bitrate }[]
 * }>}
 */
async function getMediaInfo(url) {
  return new Promise((resolve, reject) => {
    // Команда yt-dlp для получения JSON информации без скачивания
    const args = [
      url,
      '--dump-json',              // Выводит JSON со всей информацией
      '--no-warnings',
      '--socket-timeout', '10',
    ];

    const proc = spawn(YT_DLP_PATH, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(
          stderr || `yt-dlp exited with code ${code}`
        ));
      }

      try {
        const info = JSON.parse(stdout);

        // Парсим форматы
        const formats = (info.formats || [])
          .filter((f) => f.vcodec !== 'none' || f.acodec !== 'none') // Только видео или аудио
          .map((f) => ({
            formatId:  f.format_id,
            format:    f.format,
            ext:       f.ext,
            resolution: f.format_note || `${f.width}x${f.height}` || 'unknown',
            fps:       f.fps || null,
            vcodec:    f.vcodec || null,
            acodec:    f.acodec || null,
            bitrate:   f.abr ? `${f.abr}k` : f.tbr ? `${Math.round(f.tbr)}k` : null,
            filesize:  f.filesize || null,
          }))
          .slice(0, 20); // Берём только первые 20 чтобы не перегружать

        // Проверяем это плейлист или одиночное видео
        const isPlaylist = !!info.playlist_count;
        const playlistLength = info.playlist_count || 1;

        resolve({
          title:          info.title,
          thumbnail:      info.thumbnail,
          duration:       info.duration,
          isPlaylist,
          playlistLength,
          formats,
          url:            info.original_url,
          uploader:       info.uploader || null,
          uploadDate:     info.upload_date || null,
        });

      } catch (err) {
        reject(new Error(`Ошибка парсинга JSON: ${err.message}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ЗАПУСК ЗАГРУЗКИ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Запустить загрузку видео/аудио/плейлиста.
 *
 * @param {{
 *   downloadId, url, type, format, quality, fps, bitrate, outputPath,
 *   onProgress, onComplete, onError, onQueued
 * }} options
 */
function startDownload(options) {
  const {
    downloadId,
    url,
    type,                // 'video', 'audio', 'playlist-video', 'playlist-audio'
    format,             // 'mp4', 'webm', 'mp3', 'aac', ...
    quality,            // '4K', '1080p', '720p', 'best', '320k', ...
    fps,                // '60', '30', '24' для видео
    bitrate,            // '320k', '192k' для аудио
    outputPath,
    onProgress,
    onComplete,
    onError,
    onQueued,
  } = options;

  try {
    // Определяем аргументы для yt-dlp
    const args = buildYtDlpArgs({
      url,
      type,
      format,
      quality,
      fps,
      bitrate,
      outputPath,
    });

    // Определяем финальное имя файла
    const outputTemplate = path.join(
      outputPath,
      `%(title)s.${format || 'mp4'}`
    );

    // Запускаем процесс
    const proc = spawn(YT_DLP_PATH, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32', // Windows нужен shell для правильной работы
      timeout: 0, // Без таймаута (загрузка может быть долгой)
    });

    // Сохраняем процесс
    activeDownloads.set(downloadId, {
      process: proc,
      paused: false,
      filePath: null,
      startTime: Date.now(),
      totalSize: null,
    });

    // ── Парсинг stdout (прогресс) ──────────────────────────────────────────
    let progressBuffer = '';

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      progressBuffer += chunk;

      // Парсим строки вроде:
      // [download] 45.2% of ~123.45MiB at 2.34MiB/s ETA 00:45
      const lines = progressBuffer.split('\n');

      // Последняя строка может быть неполная
      progressBuffer = lines[lines.length - 1];

      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        parseProgressLine(line, downloadId, onProgress);
      }
    });

    // ── Парсинг stderr (информация и ошибки) ───────────────────────────────
    let stderrBuffer = '';

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderrBuffer += chunk;

      // Извлекаем имя файла если есть
      const fileMatch = chunk.match(/Destination: (.+?)[\r\n]/);
      if (fileMatch) {
        const metadata = activeDownloads.get(downloadId);
        if (metadata) {
          metadata.filePath = fileMatch[1].trim();
        }
      }

      // Логируем в dev-режиме
      if (process.env.NODE_ENV === 'development') {
        console.log(`[yt-dlp ${downloadId}]`, chunk.trim());
      }
    });

    // ── Завершение процесса ────────────────────────────────────────────────
    proc.on('close', (code) => {
      const metadata = activeDownloads.get(downloadId);

      if (code === 0) {
        // Успех
        const fileSize = metadata?.filePath && fs.existsSync(metadata.filePath)
          ? fs.statSync(metadata.filePath).size
          : null;

        onComplete?.({
          filePath: metadata?.filePath || outputTemplate,
          fileSize,
        });

      } else if (code === 143 || code === 137) {
        // SIGTERM или SIGKILL — нормальное завершение при отмене
        // Ничего не делаем, уже обработано в cancelDownload()

      } else {
        // Ошибка
        const errorMsg = stderrBuffer.trim()
          || `yt-dlp exited with code ${code}`;

        onError?.(new Error(errorMsg));
      }

      // Удаляем из активных
      activeDownloads.delete(downloadId);
    });

    // ── Ошибка при запуске процесса ────────────────────────────────────────
    proc.on('error', (err) => {
      onError?.(err);
      activeDownloads.delete(downloadId);
    });

  } catch (err) {
    onError?.(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// УПРАВЛЕНИЕ ЗАГРУЗКАМИ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Поставить загрузку на паузу (SIGSTOP — замораживает процесс).
 * Процесс остаётся в памяти и может быть возобновлен.
 */
function pauseDownload(downloadId) {
  const metadata = activeDownloads.get(downloadId);
  if (!metadata || metadata.paused) return;

  metadata.paused = true;

  if (process.platform !== 'win32') {
    // UNIX: отправляем SIGSTOP
    try {
      process.kill(metadata.process.pid, 'SIGSTOP');
    } catch (err) {
      console.warn(`[pauseDownload] Ошибка SIGSTOP:`, err.message);
    }
  }
}

/**
 * Возобновить загрузку (SIGCONT).
 */
function resumeDownload(downloadId, downloadRecord) {
  const metadata = activeDownloads.get(downloadId);
  if (!metadata) {
    // Процесс не запущен — перезапускаем
    startDownload({
      downloadId,
      url:        downloadRecord.url,
      type:       downloadRecord.type,
      format:     downloadRecord.format,
      quality:    downloadRecord.quality,
      fps:        downloadRecord.fps,
      bitrate:    downloadRecord.bitrate,
      outputPath: path.dirname(downloadRecord.file_path),
    });
    return;
  }

  if (!metadata.paused) return;

  metadata.paused = false;

  if (process.platform !== 'win32') {
    try {
      process.kill(metadata.process.pid, 'SIGCONT');
    } catch (err) {
      console.warn(`[resumeDownload] Ошибка SIGCONT:`, err.message);
    }
  }
}

/**
 * Отменить загрузку (SIGKILL).
 * Убивает процесс полностью, файл остаётся незавершённым.
 */
function cancelDownload(downloadId) {
  const metadata = activeDownloads.get(downloadId);
  if (!metadata) return;

  try {
    metadata.process.kill('SIGKILL');
  } catch (err) {
    console.warn(`[cancelDownload] Ошибка SIGKILL:`, err.message);
  }

  activeDownloads.delete(downloadId);
}

// ─────────────────────────────────────────────────────────────────────────────
// ПАРСИНГ ПРОГРЕССА
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Парсит строку прогресса из yt-dlp.
 * Примеры:
 *   [download] 45.2% of ~123.45MiB at 2.34MiB/s ETA 00:45
 *   [download] 100% of 256.78MiB in 2:15
 */
function parseProgressLine(line, downloadId, onProgress) {
  if (!line.includes('[download]')) return;

  try {
    // Регулярное выражение для парсинга
    const match = line.match(
      /\[download\]\s+([\d.]+)%\s+of\s+[~]?([\d.]+)(MiB|GiB|KiB|B)\s+at\s+([\d.]+)(MiB|GiB|KiB|B)\/s\s+ETA\s+([\d:]+)/
    );

    if (!match) return;

    const percent = parseFloat(match[1]);
    const sizeNum = parseFloat(match[2]);
    const sizeUnit = match[3];
    const speedNum = parseFloat(match[4]);
    const speedUnit = match[5];
    const etaStr = match[6]; // HH:MM:SS

    // Конвертируем размер в байты
    const sizeBytes = sizeNum * getUnitMultiplier(sizeUnit);

    // Конвертируем скорость в байты/сек
    const speedBytesPerSec = speedNum * getUnitMultiplier(speedUnit);

    // Парсим ETA
    const etaParts = etaStr.split(':');
    const etaSeconds = (
      parseInt(etaParts[0]) * 3600 +
      parseInt(etaParts[1]) * 60 +
      parseInt(etaParts[2])
    );

    onProgress?.({
      percent: Math.min(percent, 100),
      speed: prettyBytes(speedBytesPerSec) + '/s',
      eta: formatSeconds(etaSeconds),
      size: prettyBytes(sizeBytes),
    });

  } catch (err) {
    // Игнорируем ошибки парсинга
  }
}

/**
 * Конвертирует единицы размера в байты.
 */
function getUnitMultiplier(unit) {
  const multipliers = {
    B:   1,
    KiB: 1024,
    MiB: 1024 * 1024,
    GiB: 1024 * 1024 * 1024,
    KB:  1000,
    MB:  1000 * 1000,
    GB:  1000 * 1000 * 1000,
  };
  return multipliers[unit] || 1;
}

/**
 * Форматирует секунды в HH:MM:SS.
 */
function formatSeconds(sec) {
  const hours   = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;

  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ПОСТРОЕНИЕ АРГУМЕНТОВ YT-DLP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Построить массив аргументов для yt-dlp.
 * Выбирает правильный формат/качество/кодек в зависимости от типа загрузки.
 */
function buildYtDlpArgs(options) {
  const {
    url,
    type,       // 'video', 'audio', 'playlist-video', 'playlist-audio'
    format,     // 'mp4', 'webm', 'mp3', 'aac'
    quality,    // '1080p', '720p', '320k', 'best'
    fps,        // '60', '30' для видео
    bitrate,    // '320k', '192k' для аудио
    outputPath,
  } = options;

  const args = [url];

  // ── Выбор формата ──────────────────────────────────────────────────────────
  // yt-dlp использует format specifier: "best[ext=mp4]"
  // Это очень гибкая система выбора качества

  if (type === 'audio' || type === 'playlist-audio') {
    // Аудио
    // Выбираем формат по расширению и битрейту
    let formatSpec = 'bestaudio';

    if (format && format !== 'best') {
      if (format === 'mp3' || format === 'aac' || format === 'opus' || format === 'm4a') {
        formatSpec = `bestaudio[ext=${format}]`;
      }
    }

    args.push('-f', formatSpec);

    // Постобработка через FFmpeg для конвертации
    if (format && format !== 'best') {
      args.push('-x', '--audio-format', format);

      if (bitrate && bitrate !== 'best') {
        // Убираем 'k' если есть
        const bitrateNum = bitrate.replace('k', '');
        args.push('--audio-quality', bitrateNum + 'k');
      }
    }

  } else {
    // Видео
    // Выбираем видео + аудио по качеству
    let formatSpec = 'best';

    if (quality === 'best') {
      formatSpec = 'bestvideo+bestaudio/best';
    } else if (quality === '4K') {
      formatSpec = 'bestvideo[height>=2160]+bestaudio/best[height>=2160]/best';
    } else if (quality === '1080p') {
      formatSpec = 'bestvideo[height=1080]+bestaudio/best[height=1080]/best';
    } else if (quality === '720p') {
      formatSpec = 'bestvideo[height=720]+bestaudio/best[height=720]/best';
    } else if (quality === '480p') {
      formatSpec = 'bestvideo[height=480]+bestaudio/best[height=480]/best';
    } else if (quality === '360p') {
      formatSpec = 'bestvideo[height=360]+bestaudio/best[height=360]/best';
    }

    // Ограничиваем по FPS если нужно
    if (fps && fps !== '60') {
      formatSpec += `[fps<=${fps}]`;
    }

    args.push('-f', formatSpec);

    // Постобработка: мерджим видео+аудио и конвертируем если нужно
    if (format && format !== 'best') {
      args.push('-o', `%(title)s.${format}`);
      args.push('--merge-output-format', format);
    }
  }

  // ── Плейлисты ──────────────────────────────────────────────────────────────
  if (type.includes('playlist')) {
    args.push('--yes-playlist');
    args.push('-o', path.join(outputPath, '%(playlist)s/%(playlist_index)s - %(title)s.%(ext)s'));
  } else {
    args.push('--no-playlist');
    args.push('-o', path.join(outputPath, '%(title)s.%(ext)s'));
  }

  // ── Общие аргументы ────────────────────────────────────────────────────────
  args.push(
    '--progress-template', '%(progress)s',  // Форматированный прогресс
    '--no-warnings',
    '--socket-timeout', '30',
    '--retries', '3',
  );

  return args;
}

// ─────────────────────────────────────────────────────────────────────────────
// ЭКСПОРТ
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  getMediaInfo,
  startDownload,
  pauseDownload,
  resumeDownload,
  cancelDownload,
};
