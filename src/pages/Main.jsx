// ─────────────────────────────────────────────────────────────────────────────
// src/pages/Main.jsx
//
// Главная страница приложения.
// Содержит:
//   - Кастомный titlebar (минимизация, развёртывание, закрытие)
//   - URL input для вставки ссылки
//   - Format picker для выбора качества/формата
//   - 4 action buttons (видео, аудио, плейлист×2)
//   - Очередь загрузок
//   - История загрузок
//   - Настройки
//
// NOTE: Это будет переписано когда пользователь скинет скетч UI.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Music, ListMusic, Settings, History } from 'lucide-react';

function MainPage({ user, tab = 'download' }) {
  const { t } = useTranslation();
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaInfo, setMediaInfo] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  function handlePasteUrl() {
    // Используем Clipboard API если доступен
    if (navigator.clipboard) {
      navigator.clipboard.readText().then(text => {
        setMediaUrl(text);
      });
    }
  }

  async function handleGetInfo() {
    if (!mediaUrl.trim()) return;

    setIsLoading(true);
    try {
      const info = await window.api.download.getInfo(mediaUrl);
      if (info.success) {
        setMediaInfo(info);
      }
    } catch (err) {
      console.error('[getInfo]', err);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="w-full h-full flex flex-col bg-slate-950">
      {/* TitleBar */}
      <div className="titlebar h-12 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-4">
        <div className="text-sm font-medium text-slate-400">
          YT Downloader
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => window.api.window.minimize()}
            className="w-8 h-8 hover:bg-slate-800 rounded transition flex items-center justify-center text-slate-400"
          >
            −
          </button>
          <button
            onClick={() => window.api.window.maximizeToggle()}
            className="w-8 h-8 hover:bg-slate-800 rounded transition flex items-center justify-center text-slate-400"
          >
            □
          </button>
          <button
            onClick={() => window.api.window.close()}
            className="w-8 h-8 hover:bg-red-900/30 hover:text-red-400 rounded transition flex items-center justify-center text-slate-400"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-auto">
        <div className="p-8 max-w-6xl mx-auto">
          {/* Greeting */}
          <div className="mb-8">
            <h1 className="text-4xl font-bold text-white mb-2">
              Привет, {user?.name || 'Пользователь'} 👋
            </h1>
            <p className="text-slate-400">
              Вставьте ссылку чтобы начать загрузку видео или музыки
            </p>
          </div>

          {/* URL Input Section */}
          {tab === 'download' && (
            <div className="space-y-6">
              {/* URL Input */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
                <label className="block text-sm font-medium text-slate-300 mb-3">
                  Ссылка на видео / аудио / плейлист
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={mediaUrl}
                    onChange={(e) => setMediaUrl(e.target.value)}
                    placeholder="https://www.youtube.com/watch?v=..."
                    className="flex-1 px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                  />
                  <button
                    onClick={handlePasteUrl}
                    className="px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-slate-300 transition"
                  >
                    Вставить
                  </button>
                  <button
                    onClick={handleGetInfo}
                    disabled={isLoading || !mediaUrl.trim()}
                    className="px-6 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg transition font-medium"
                  >
                    {isLoading ? '...' : 'Получить'}
                  </button>
                </div>
              </div>

              {/* Action Buttons */}
              {mediaInfo && (
                <div className="grid grid-cols-2 gap-3">
                  <button className="flex items-center justify-center gap-2 p-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition font-medium">
                    <Download className="w-5 h-5" />
                    Скачать видео
                  </button>
                  <button className="flex items-center justify-center gap-2 p-4 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition font-medium">
                    <Music className="w-5 h-5" />
                    Скачать музыку
                  </button>
                  <button className="flex items-center justify-center gap-2 p-4 bg-cyan-600 hover:bg-cyan-700 text-white rounded-lg transition font-medium">
                    <ListMusic className="w-5 h-5" />
                    Плейлист (видео)
                  </button>
                  <button className="flex items-center justify-center gap-2 p-4 bg-pink-600 hover:bg-pink-700 text-white rounded-lg transition font-medium">
                    <ListMusic className="w-5 h-5" />
                    Плейлист (музыка)
                  </button>
                </div>
              )}
            </div>
          )}

          {/* History Tab */}
          {tab === 'history' && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
              <h2 className="text-xl font-bold text-white mb-4">История загрузок</h2>
              <p className="text-slate-400">История загрузок будет здесь...</p>
            </div>
          )}

          {/* Settings Tab */}
          {tab === 'settings' && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
              <h2 className="text-xl font-bold text-white mb-4">Настройки</h2>
              <p className="text-slate-400">Настройки будут здесь...</p>
            </div>
          )}
        </div>
      </div>

      {/* Bottom Navigation */}
      <div className="bg-slate-900 border-t border-slate-800 h-16 flex items-center justify-center gap-4 px-4">
        <button
          onClick={() => window.location.hash = '/'}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg transition ${
            tab === 'download'
              ? 'bg-indigo-600 text-white'
              : 'text-slate-400 hover:text-slate-300'
          }`}
        >
          <Download className="w-5 h-5" />
          Загрузить
        </button>
        <button
          onClick={() => window.location.hash = '/history'}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg transition ${
            tab === 'history'
              ? 'bg-indigo-600 text-white'
              : 'text-slate-400 hover:text-slate-300'
          }`}
        >
          <History className="w-5 h-5" />
          История
        </button>
        <button
          onClick={() => window.location.hash = '/settings'}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg transition ${
            tab === 'settings'
              ? 'bg-indigo-600 text-white'
              : 'text-slate-400 hover:text-slate-300'
          }`}
        >
          <Settings className="w-5 h-5" />
          Настройки
        </button>
      </div>
    </div>
  );
}

export default MainPage;
