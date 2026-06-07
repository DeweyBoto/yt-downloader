// ─────────────────────────────────────────────────────────────────────────────
// src/store/downloads.js
//
// Zustand store для управления очередью и историей загрузок.
// ─────────────────────────────────────────────────────────────────────────────

import { create } from 'zustand';

export const useDownloadStore = create((set) => ({
  // ── Состояние ────────────────────────────────────────────────────────────
  downloads: {}, // { downloadId: { ...data } }
  queue: [],     // [downloadId, downloadId, ...]

  // ── Actions ───────────────────────────────────────────────────────────────

  addDownload: (downloadId, data) =>
    set((state) => ({
      downloads: {
        ...state.downloads,
        [downloadId]: {
          id: downloadId,
          status: 'pending',
          progress: 0,
          ...data,
          createdAt: new Date(),
        },
      },
      queue: [...state.queue, downloadId],
    })),

  updateDownload: (downloadId, updates) =>
    set((state) => ({
      downloads: {
        ...state.downloads,
        [downloadId]: {
          ...state.downloads[downloadId],
          ...updates,
        },
      },
    })),

  removeDownload: (downloadId) =>
    set((state) => {
      const newDownloads = { ...state.downloads };
      delete newDownloads[downloadId];

      return {
        downloads: newDownloads,
        queue: state.queue.filter((id) => id !== downloadId),
      };
    }),

  updateProgress: (downloadId, percent, speed, eta) =>
    set((state) => ({
      downloads: {
        ...state.downloads,
        [downloadId]: {
          ...state.downloads[downloadId],
          progress: percent,
          speed,
          eta,
        },
      },
    })),

  clearCompleted: () =>
    set((state) => {
      const newDownloads = {};
      for (const [id, data] of Object.entries(state.downloads)) {
        if (data.status !== 'completed') {
          newDownloads[id] = data;
        }
      }
      return { downloads: newDownloads };
    }),

  clearAll: () => ({
    downloads: {},
    queue: [],
  }),
}));

// ── Селекторы ──────────────────────────────────────────────────────────────

export const selectActiveDownloads = (state) =>
  Object.values(state.downloads).filter(
    (d) => d.status === 'downloading' || d.status === 'paused'
  );

export const selectCompletedDownloads = (state) =>
  Object.values(state.downloads).filter((d) => d.status === 'completed');

export const selectFailedDownloads = (state) =>
  Object.values(state.downloads).filter((d) => d.status === 'failed');

export const selectDownloadById = (downloadId) => (state) =>
  state.downloads[downloadId];
