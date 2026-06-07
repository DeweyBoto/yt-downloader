// ─────────────────────────────────────────────────────────────────────────────
// src/components/ThemeProvider.jsx
//
// Провайдер тем для всего приложения.
// Управляет светлой/тёмной темой и акцентным цветом.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';

function ThemeProvider({ children }) {
  const [theme, setTheme] = useState('dark');
  const [accentColor, setAccentColor] = useState('#6366f1');

  // ── Инициализация при загрузке ────────────────────────────────────────────
  useEffect(() => {
    initializeTheme();

    // Слушаем изменения настроек из других окон
    const unsub = window.api.settings?.onSettingsChanged?.((settings) => {
      if (settings.theme) setTheme(settings.theme);
      if (settings.accentColor) setAccentColor(settings.accentColor);
    });

    return () => unsub?.();
  }, []);

  async function initializeTheme() {
    try {
      const settings = await window.api.settings.getAll?.();
      if (settings) {
        setTheme(settings.theme || 'dark');
        setAccentColor(settings.accentColor || '#6366f1');
      }
    } catch (err) {
      console.warn('[ThemeProvider] Не удалось загрузить настройки', err);
    }
  }

  // ── Применение темы ───────────────────────────────────────────────────────
  useEffect(() => {
    const html = document.documentElement;

    // Определяем реальную тему (если system - смотрим предпочтения ОС)
    let realTheme = theme;
    if (theme === 'system') {
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      realTheme = isDark ? 'dark' : 'light';
    }

    html.setAttribute('data-theme', realTheme);

    // Применяем акцентный цвет через CSS переменную
    html.style.setProperty('--accent', accentColor);

    // Генерируем variation цветов для акцента
    const lighter = lightenColor(accentColor, 20);
    const darker = darkenColor(accentColor, 20);

    html.style.setProperty('--accent-light', lighter);
    html.style.setProperty('--accent-dark', darker);

  }, [theme, accentColor]);

  // ── Функции для цветов ────────────────────────────────────────────────────

  function lightenColor(hex, percent) {
    const num = parseInt(hex.replace('#', ''), 16);
    const amt = Math.round(2.55 * percent);
    const R = (num >> 16) + amt;
    const G = (num >> 8 & 0x00FF) + amt;
    const B = (num & 0x0000FF) + amt;

    return '#' + (
      0x1000000 + (R < 255 ? R < 1 ? 0 : R : 255) * 0x10000 +
      (G < 255 ? G < 1 ? 0 : G : 255) * 0x100 +
      (B < 255 ? B < 1 ? 0 : B : 255)
    ).toString(16).slice(1);
  }

  function darkenColor(hex, percent) {
    const num = parseInt(hex.replace('#', ''), 16);
    const amt = Math.round(2.55 * percent);
    const R = (num >> 16) - amt;
    const G = (num >> 8 & 0x00FF) - amt;
    const B = (num & 0x0000FF) - amt;

    return '#' + (
      0x1000000 + (R > 0 ? R : 0) * 0x10000 +
      (G > 0 ? G : 0) * 0x100 +
      (B > 0 ? B : 0)
    ).toString(16).slice(1);
  }

  return children;
}

export default ThemeProvider;
