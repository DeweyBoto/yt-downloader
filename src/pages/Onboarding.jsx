// ─────────────────────────────────────────────────────────────────────────────
// src/pages/Onboarding.jsx
//
// Страница онбординга — 3-4 слайда с объяснением функций приложения.
// Показывается один раз после регистрации.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Download, Settings, Share2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const SLIDES = [
  {
    id: 'welcome',
    icon: Download,
    titleKey: 'onboard.welcome_title',
    descKey: 'onboard.welcome_desc',
    color: 'from-indigo-600 to-purple-600',
  },
  {
    id: 'features',
    icon: Share2,
    titleKey: 'onboard.features_title',
    descKey: 'onboard.features_desc',
    color: 'from-cyan-600 to-blue-600',
  },
  {
    id: 'formats',
    icon: Settings,
    titleKey: 'onboard.formats_title',
    descKey: 'onboard.formats_desc',
    color: 'from-emerald-600 to-teal-600',
  },
  {
    id: 'ready',
    icon: Download,
    titleKey: 'onboard.ready_title',
    descKey: 'onboard.ready_desc',
    color: 'from-violet-600 to-pink-600',
  },
];

function OnboardingPage({ userId }) {
  const { t } = useTranslation();
  const [currentSlide, setCurrentSlide] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  const slide = SLIDES[currentSlide];
  const Icon = slide.icon;

  function nextSlide() {
    if (currentSlide < SLIDES.length - 1) {
      setCurrentSlide(currentSlide + 1);
    }
  }

  function prevSlide() {
    if (currentSlide > 0) {
      setCurrentSlide(currentSlide - 1);
    }
  }

  async function completeOnboarding() {
    setIsLoading(true);
    try {
      window.api.onboarding.complete(userId);
    } catch (err) {
      console.error('[Onboarding] Error:', err);
      setIsLoading(false);
    }
  }

  return (
    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-950 to-black p-4">
      {/* Декоративные элементы */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-indigo-500 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-blob" />
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-purple-500 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-blob animation-delay-2000" />
      </div>

      {/* Контейнер */}
      <motion.div
        className="relative w-full max-w-2xl"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-12 shadow-2xl">
          {/* Progress bar */}
          <div className="mb-8 flex gap-2">
            {SLIDES.map((_, idx) => (
              <motion.div
                key={idx}
                className={`h-1 flex-1 rounded-full transition-colors ${
                  idx === currentSlide
                    ? 'bg-indigo-500'
                    : idx < currentSlide
                      ? 'bg-indigo-600/50'
                      : 'bg-slate-700'
                }`}
                layoutId="progress"
              />
            ))}
          </div>

          {/* Контент слайда */}
          <AnimatePresence mode="wait">
            <motion.div
              key={currentSlide}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.3 }}
              className="text-center mb-8"
            >
              {/* Иконка */}
              <motion.div
                className={`w-20 h-20 mx-auto mb-6 rounded-full bg-gradient-to-br ${slide.color} flex items-center justify-center`}
                animate={{ scale: [1, 1.05, 1] }}
                transition={{ duration: 2, repeat: Infinity }}
              >
                <Icon className="w-10 h-10 text-white" />
              </motion.div>

              {/* Заголовок */}
              <h2 className="text-3xl font-bold text-white mb-4">
                {t(slide.titleKey)}
              </h2>

              {/* Описание */}
              <p className="text-slate-400 text-lg leading-relaxed max-w-lg mx-auto">
                {t(slide.descKey)}
              </p>
            </motion.div>
          </AnimatePresence>

          {/* Кнопки навигации */}
          <div className="flex gap-3 justify-between mt-12">
            <button
              onClick={prevSlide}
              disabled={currentSlide === 0 || isLoading}
              className="px-6 py-2 border border-slate-700 hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed text-slate-300 font-medium rounded-lg transition"
            >
              {t('common.back')}
            </button>

            {currentSlide === SLIDES.length - 1 ? (
              <button
                onClick={completeOnboarding}
                disabled={isLoading}
                className="px-6 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition flex items-center gap-2"
              >
                {isLoading ? '...' : t('onboard.get_started')}
              </button>
            ) : (
              <button
                onClick={nextSlide}
                className="px-6 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition flex items-center gap-2"
              >
                {t('common.next')}
                <ChevronRight className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Индикатор слайда */}
          <div className="mt-6 text-center text-sm text-slate-500">
            {currentSlide + 1} / {SLIDES.length}
          </div>
        </div>
      </motion.div>
    </div>
  );
}

export default OnboardingPage;
