// ─────────────────────────────────────────────────────────────────────────────
// src/App.jsx
//
// Корневой компонент приложения.
//
// ОТВЕЧАЕТ ЗА:
//   1. Роутинг (Auth → Onboarding → Main)
//   2. Инициализацию тем (светлая/тёмная/акцент)
//   3. Загрузку данных пользователя
//   4. Инициализацию глобального состояния (Zustand)
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

// Pages
import AuthPage from './pages/Auth';
import OnboardingPage from './pages/Onboarding';
import MainPage from './pages/Main';

// Providers/Wrappers
import ThemeProvider from './components/ThemeProvider';
import LoadingScreen from './components/LoadingScreen';

function App() {
  const { i18n } = useTranslation();
  const [isReady, setIsReady] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  // ── Инициализация при загрузке ────────────────────────────────────────────
  useEffect(() => {
    initializeApp();
  }, []);

  async function initializeApp() {
    try {
      setIsLoading(true);

      // 1. Получаем информацию о текущем пользователе
      const user = await window.api.auth.getCurrentUser();
      setCurrentUser(user);

      // 2. Получаем системную информацию (язык, платформа)
      const sysInfo = await window.api.system.getInfo();

      // 3. Определяем язык: если стоит 'auto', то берём из системы
      const currentLang = i18n.language;
      if (currentLang === 'auto' || !currentLang) {
        const systemLang = sysInfo.osLanguage || 'en';
        i18n.changeLanguage(systemLang);
      }

      // 4. Слушаем события пользователя (приходят от main.js)
      // Когда окно открывается, main.js отправляет данные пользователя
      const unsub = window.api.system.onUserData((userData) => {
        setCurrentUser(userData);
      });

      setIsReady(true);
      return () => unsub?.();

    } catch (err) {
      console.error('[App] Init error:', err);
      // Даже при ошибке продолжаем работу
      setIsReady(true);
    } finally {
      setIsLoading(false);
    }
  }

  // ── Рендер ────────────────────────────────────────────────────────────────

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (!isReady) {
    return <LoadingScreen />;
  }

  return (
    <ThemeProvider>
      <Router>
        <Routes>
          {/* Если нет пользователя → Auth */}
          {!currentUser ? (
            <>
              <Route path="/auth" element={<AuthPage />} />
              <Route path="*" element={<Navigate to="/auth" replace />} />
            </>
          ) : !currentUser.onboarding_done ? (
            // Если пользователь есть но онбординг не завершён → Onboarding
            <>
              <Route path="/onboarding" element={<OnboardingPage userId={currentUser.id} />} />
              <Route path="*" element={<Navigate to="/onboarding" replace />} />
            </>
          ) : (
            // Всё готово → главный экран
            <>
              <Route path="/" element={<MainPage user={currentUser} />} />
              <Route path="/history" element={<MainPage user={currentUser} tab="history" />} />
              <Route path="/settings" element={<MainPage user={currentUser} tab="settings" />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </>
          )}
        </Routes>
      </Router>
    </ThemeProvider>
  );
}

export default App;
