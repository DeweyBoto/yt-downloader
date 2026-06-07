// ─────────────────────────────────────────────────────────────────────────────
// src/components/LoadingScreen.jsx
//
// Экран загрузки - показывается при инициализации приложения.
// ─────────────────────────────────────────────────────────────────────────────

import { motion } from 'framer-motion';

function LoadingScreen() {
  return (
    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-slate-900 to-slate-950">
      <motion.div
        className="flex flex-col items-center gap-6"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5 }}
      >
        {/* Спиннер */}
        <motion.div
          className="w-12 h-12 border-4 border-slate-700 border-t-indigo-500 rounded-full"
          animate={{ rotate: 360 }}
          transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
        />

        {/* Текст */}
        <motion.p
          className="text-slate-400 text-sm font-medium"
          animate={{ opacity: [0.6, 1, 0.6] }}
          transition={{ duration: 2, repeat: Infinity }}
        >
          YT Downloader
        </motion.p>
      </motion.div>
    </div>
  );
}

export default LoadingScreen;
