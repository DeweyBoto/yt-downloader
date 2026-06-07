// ─────────────────────────────────────────────────────────────────────────────
// src/main.jsx
//
// Точка входа React приложения.
// Монтирует App в DOM, инициализирует i18n, глобальное состояние.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';

// Инициализируем i18next (интернационализация)
import i18n from './i18n';

// Инициализируем Zustand store (если нужны глобальные обработчики)
import { useDownloadStore } from './store/downloads';

// Ждём инициализации i18n перед рендерингом
i18n.on('initialized', () => {
  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});

// На случай если i18n уже инициализирован
if (i18n.isInitialized) {
  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
