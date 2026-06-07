// ─────────────────────────────────────────────────────────────────────────────
// src/pages/Auth.jsx
//
// Страница регистрации и входа.
// Первый экран которой видит пользователь при первом запуске.
//
// ФУНКЦИИ:
//   - Регистрация: имя + email + пароль + фото
//   - Вход: email + пароль
//   - OAuth: Google / GitHub (будут ссылки на браузер)
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Mail, Lock, User, Image, Github, Chrome } from 'lucide-react';
import { motion } from 'framer-motion';

function AuthPage() {
  const { t } = useTranslation();
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [avatarPreview, setAvatarPreview] = useState(null);

  // Form state
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    avatar: null,
  });

  // ── OAuth слушатели ───────────────────────────────────────────────────────
  useEffect(() => {
    const unsubCallback = window.api.auth.onOAuthCallback(async (data) => {
      await handleOAuthCallback(data);
    });

    const unsubError = window.api.auth.onOAuthError((data) => {
      setError(`OAuth ошибка: ${data.error}`);
    });

    return () => {
      unsubCallback?.();
      unsubError?.();
    };
  }, []);

  // ── Handlers ───────────────────────────────────────────────────────────────

  function handleInputChange(e) {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    setError('');
  }

  function handleAvatarChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    // Валидация (должно быть изображение, <5MB)
    if (!file.type.startsWith('image/')) {
      setError(t('auth.avatar_must_be_image'));
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      setError(t('auth.avatar_max_size'));
      return;
    }

    // Читаем файл как base64
    const reader = new FileReader();
    reader.onload = (evt) => {
      const base64 = evt.target?.result;
      setFormData(prev => ({ ...prev, avatar: base64 }));
      setAvatarPreview(base64);
    };
    reader.readAsDataURL(file);
  }

  async function handleRegister(e) {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      const result = await window.api.auth.register({
        name: formData.name.trim(),
        email: formData.email.trim().toLowerCase(),
        password: formData.password,
        avatarBase64: formData.avatar,
      });

      if (!result.success) {
        setError(result.error || t('auth.registration_failed'));
        return;
      }

      // Уведомляем main.js что регистрация завершена
      window.api.auth.notifyRegistrationComplete(result.userId);

    } catch (err) {
      setError(err.message || t('auth.error'));
    } finally {
      setIsLoading(false);
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      const result = await window.api.auth.loginLocal({
        email: formData.email.trim().toLowerCase(),
        password: formData.password,
      });

      if (!result.success) {
        setError(result.error || t('auth.login_failed'));
        return;
      }

      window.api.auth.notifyLoginComplete(result.userId);

    } catch (err) {
      setError(err.message || t('auth.error'));
    } finally {
      setIsLoading(false);
    }
  }

  async function handleOAuth(provider) {
    setIsLoading(true);
    setError('');

    try {
      await window.api.auth.startOAuth(provider);
      // Браузер откроется, результат придёт через onOAuthCallback
    } catch (err) {
      setError(err.message || t('auth.oauth_error'));
      setIsLoading(false);
    }
  }

  async function handleOAuthCallback(data) {
    setIsLoading(true);
    setError('');

    try {
      const result = await window.api.auth.handleOAuthCallback(data);

      if (!result.success) {
        setError(result.error || t('auth.oauth_failed'));
        return;
      }

      window.api.auth.notifyLoginComplete(result.userId);

    } catch (err) {
      setError(err.message || t('auth.error'));
    } finally {
      setIsLoading(false);
    }
  }

  // ── Рендер ────────────────────────────────────────────────────────────────

  return (
    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-950 to-black p-4">
      {/* Декоративный фон */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-indigo-500 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-blob" />
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-purple-500 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-blob animation-delay-2000" />
      </div>

      {/* Контейнер формы */}
      <motion.div
        className="relative w-full max-w-sm"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl">
          {/* Заголовок */}
          <div className="mb-8 text-center">
            <h1 className="text-3xl font-bold text-white mb-2">YT Downloader</h1>
            <p className="text-slate-400 text-sm">
              {mode === 'login'
                ? t('auth.welcome_back')
                : t('auth.create_account')}
            </p>
          </div>

          {/* Форма */}
          <form onSubmit={mode === 'login' ? handleLogin : handleRegister} className="space-y-4">
            {/* Имя (только для регистрации) */}
            {mode === 'register' && (
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  {t('auth.name')}
                </label>
                <div className="relative">
                  <User className="absolute left-3 top-3 w-5 h-5 text-slate-500" />
                  <input
                    type="text"
                    name="name"
                    value={formData.name}
                    onChange={handleInputChange}
                    placeholder={t('auth.enter_name')}
                    className="w-full pl-10 pr-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition"
                    disabled={isLoading}
                  />
                </div>
              </div>
            )}

            {/* Email */}
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                Email
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-3 w-5 h-5 text-slate-500" />
                <input
                  type="email"
                  name="email"
                  value={formData.email}
                  onChange={handleInputChange}
                  placeholder={t('auth.enter_email')}
                  className="w-full pl-10 pr-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition"
                  disabled={isLoading}
                  required
                />
              </div>
            </div>

            {/* Пароль */}
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                {t('auth.password')}
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-3 w-5 h-5 text-slate-500" />
                <input
                  type="password"
                  name="password"
                  value={formData.password}
                  onChange={handleInputChange}
                  placeholder={t('auth.enter_password')}
                  className="w-full pl-10 pr-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition"
                  disabled={isLoading}
                  required
                />
              </div>
            </div>

            {/* Аватар (только для регистрации) */}
            {mode === 'register' && (
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  {t('auth.profile_photo')}
                </label>
                <label className="cursor-pointer">
                  <div className="w-full flex items-center justify-center px-4 py-6 border-2 border-dashed border-slate-700 rounded-lg hover:border-indigo-500 transition">
                    {avatarPreview ? (
                      <img src={avatarPreview} alt="Preview" className="w-12 h-12 rounded-full object-cover" />
                    ) : (
                      <div className="text-center">
                        <Image className="w-6 h-6 text-slate-500 mx-auto mb-2" />
                        <p className="text-xs text-slate-400">{t('auth.click_to_upload')}</p>
                      </div>
                    )}
                  </div>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleAvatarChange}
                    className="hidden"
                    disabled={isLoading}
                  />
                </label>
              </div>
            )}

            {/* Ошибка */}
            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
                <p className="text-red-400 text-sm">{error}</p>
              </div>
            )}

            {/* Кнопка отправки */}
            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-2 px-4 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition mt-6"
            >
              {isLoading ? '...' : (mode === 'login' ? t('auth.login') : t('auth.register'))}
            </button>
          </form>

          {/* Разделитель */}
          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-slate-700" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 bg-slate-900 text-slate-400">{t('auth.or')}</span>
            </div>
          </div>

          {/* OAuth кнопки */}
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => handleOAuth('google')}
              disabled={isLoading}
              className="w-full py-2 px-4 border border-slate-700 hover:bg-slate-800 disabled:opacity-50 text-slate-300 font-medium rounded-lg transition flex items-center justify-center gap-2"
            >
              <Chrome className="w-4 h-4" />
              Google
            </button>
            <button
              type="button"
              onClick={() => handleOAuth('github')}
              disabled={isLoading}
              className="w-full py-2 px-4 border border-slate-700 hover:bg-slate-800 disabled:opacity-50 text-slate-300 font-medium rounded-lg transition flex items-center justify-center gap-2"
            >
              <Github className="w-4 h-4" />
              GitHub
            </button>
          </div>

          {/* Переключение между режимами */}
          <div className="mt-6 text-center text-sm text-slate-400">
            {mode === 'login' ? (
              <>
                {t('auth.no_account')}{' '}
                <button
                  type="button"
                  onClick={() => setMode('register')}
                  className="text-indigo-400 hover:text-indigo-300 font-medium transition"
                >
                  {t('auth.sign_up')}
                </button>
              </>
            ) : (
              <>
                {t('auth.have_account')}{' '}
                <button
                  type="button"
                  onClick={() => setMode('login')}
                  className="text-indigo-400 hover:text-indigo-300 font-medium transition"
                >
                  {t('auth.sign_in')}
                </button>
              </>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  );
}

export default AuthPage;
