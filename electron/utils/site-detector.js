// ─────────────────────────────────────────────────────────────────────────────
// electron/utils/site-detector.js
//
// Определение сайта по URL для логирования и аналитики.
// Используется в UI для показания иконки сайта рядом с загрузкой.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const SITES = {
  youtube: {
    name: 'YouTube',
    icon: '▶',
    patterns: [
      /(?:https?:\/\/)?(?:www\.)?youtube\.com/,
      /(?:https?:\/\/)?(?:www\.)?youtu\.be/,
      /(?:https?:\/\/)?(?:www\.)?youtube-nocookie\.com/,
    ],
  },
  instagram: {
    name: 'Instagram',
    icon: '📷',
    patterns: [
      /(?:https?:\/\/)?(?:www\.)?instagram\.com/,
    ],
  },
  tiktok: {
    name: 'TikTok',
    icon: '🎵',
    patterns: [
      /(?:https?:\/\/)?(?:www\.)?tiktok\.com/,
      /(?:https?:\/\/)?(?:www\.)?vm\.tiktok\.com/,
      /(?:https?:\/\/)?(?:www\.)?vt\.tiktok\.com/,
    ],
  },
  facebook: {
    name: 'Facebook',
    icon: 'f',
    patterns: [
      /(?:https?:\/\/)?(?:www\.)?facebook\.com/,
      /(?:https?:\/\/)?(?:www\.)?fb\.watch/,
    ],
  },
  twitter: {
    name: 'Twitter/X',
    icon: '𝕏',
    patterns: [
      /(?:https?:\/\/)?(?:www\.)?twitter\.com/,
      /(?:https?:\/\/)?(?:www\.)?x\.com/,
      /(?:https?:\/\/)?(?:www\.)?tweet\.tv/,
    ],
  },
  soundcloud: {
    name: 'SoundCloud',
    icon: '🔊',
    patterns: [
      /(?:https?:\/\/)?(?:www\.)?soundcloud\.com/,
    ],
  },
  spotify: {
    name: 'Spotify',
    icon: '♫',
    patterns: [
      /(?:https?:\/\/)?(?:www\.)?spotify\.com/,
      /(?:https?:\/\/)?open\.spotify\.com/,
    ],
  },
  twitch: {
    name: 'Twitch',
    icon: '▮▮',
    patterns: [
      /(?:https?:\/\/)?(?:www\.)?twitch\.tv/,
      /(?:https?:\/\/)?clips\.twitch\.tv/,
    ],
  },
  reddit: {
    name: 'Reddit',
    icon: 'r',
    patterns: [
      /(?:https?:\/\/)?(?:www\.)?reddit\.com/,
    ],
  },
  vimeo: {
    name: 'Vimeo',
    icon: '▶',
    patterns: [
      /(?:https?:\/\/)?(?:www\.)?vimeo\.com/,
    ],
  },
  dailymotion: {
    name: 'Dailymotion',
    icon: '▶',
    patterns: [
      /(?:https?:\/\/)?(?:www\.)?dailymotion\.com/,
    ],
  },
  pinterest: {
    name: 'Pinterest',
    icon: 'P',
    patterns: [
      /(?:https?:\/\/)?(?:www\.)?pinterest\.com/,
    ],
  },
  telegram: {
    name: 'Telegram',
    icon: '✈',
    patterns: [
      /(?:https?:\/\/)?(?:www\.)?t\.me/,
      /(?:https?:\/\/)?(?:www\.)?telegram\.com/,
    ],
  },
  youtube_music: {
    name: 'YouTube Music',
    icon: '♫',
    patterns: [
      /(?:https?:\/\/)?(?:www\.)?music\.youtube\.com/,
    ],
  },
  flickr: {
    name: 'Flickr',
    icon: '📷',
    patterns: [
      /(?:https?:\/\/)?(?:www\.)?flickr\.com/,
    ],
  },
  vk: {
    name: 'VKontakte',
    icon: 'V',
    patterns: [
      /(?:https?:\/\/)?(?:www\.)?vk\.com/,
      /(?:https?:\/\/)?(?:www\.)?vimeo\.vk\.com/,
    ],
  },
};

/**
 * Определить сайт по URL.
 * @param {string} url
 * @returns {{ id: string, name: string, icon: string } | null}
 */
function detectSite(url) {
  if (!url || typeof url !== 'string') return null;

  const urlLower = url.toLowerCase();

  // Проверяем в порядке приоритета
  // (YouTube Music перед обычным YouTube чтобы не спутать)
  const priorityOrder = [
    'youtube_music',
    'spotify',
    'soundcloud',
    'youtube',
    'instagram',
    'tiktok',
    'facebook',
    'twitter',
    'twitch',
    'reddit',
    'vimeo',
    'dailymotion',
    'pinterest',
    'telegram',
    'flickr',
    'vk',
  ];

  for (const siteId of priorityOrder) {
    const site = SITES[siteId];
    if (!site) continue;

    for (const pattern of site.patterns) {
      if (pattern.test(urlLower)) {
        return {
          id: siteId,
          name: site.name,
          icon: site.icon,
        };
      }
    }
  }

  // Если не определили — возвращаем null
  return null;
}

/**
 * Получить объект сайта по ID.
 * @param {string} siteId
 * @returns {Object | null}
 */
function getSiteById(siteId) {
  return SITES[siteId] ?? null;
}

/**
 * Получить все известные сайты.
 * @returns {Object}
 */
function getAllSites() {
  return { ...SITES };
}

/**
 * Проверить поддерживается ли сайт.
 * @param {string} url
 * @returns {boolean}
 */
function isSiteSupported(url) {
  return detectSite(url) !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  detectSite,
  getSiteById,
  getAllSites,
  isSiteSupported,
};
