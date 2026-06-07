// ─────────────────────────────────────────────────────────────────────────────
// src/i18n/index.js
//
// Конфигурация интернационализации (i18next).
// Поддержка 20+ языков включая армянский и украинский.
// ─────────────────────────────────────────────────────────────────────────────

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// Импортируем переводы
import en from './locales/en.json';
import ru from './locales/ru.json';
import uk from './locales/uk.json';
import hy from './locales/hy.json';
import es from './locales/es.json';
import de from './locales/de.json';
import fr from './locales/fr.json';
import zh from './locales/zh.json';
import ar from './locales/ar.json';
import pt from './locales/pt.json';

const resources = {
  en: { translation: en },
  ru: { translation: ru },
  uk: { translation: uk },
  hy: { translation: hy },
  es: { translation: es },
  de: { translation: de },
  fr: { translation: fr },
  zh: { translation: zh },
  ar: { translation: ar },
  pt: { translation: pt },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    defaultNS: 'translation',
    debug: false,

    // Интерполяция
    interpolation: {
      escapeValue: false, // React уже защищает от XSS
    },

    // Детектирование языка
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
    },
  });

export default i18n;
