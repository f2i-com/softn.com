/**
 * Preview Store - Manages preview state and settings
 */

import { create } from 'zustand';
import type { PreviewState } from '../types/builder';

interface PreviewStore extends PreviewState {
  // Actions
  setMode: (mode: 'split' | 'preview' | 'code') => void;
  setScale: (scale: number) => void;
  setDevicePreset: (preset: 'desktop' | 'tablet' | 'mobile' | 'custom') => void;
  setCustomDimensions: (width: number, height: number) => void;
  reset: () => void;
}

const deviceDimensions = {
  desktop: { width: 1280, height: 720 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 375, height: 667 },
};

export const usePreviewStore = create<PreviewStore>((set) => ({
  mode: 'split',
  scale: 1,
  devicePreset: 'desktop',
  customWidth: 1280,
  customHeight: 720,

  setMode: (mode) => {
    set({ mode });
  },

  setScale: (scale) => {
    set({ scale: Math.max(0.25, Math.min(2, scale)) });
  },

  setDevicePreset: (preset) => {
    if (preset === 'custom') {
      set({ devicePreset: preset });
    } else {
      const dims = deviceDimensions[preset];
      set({
        devicePreset: preset,
        customWidth: dims.width,
        customHeight: dims.height,
      });
    }
  },

  setCustomDimensions: (width, height) => {
    set({
      devicePreset: 'custom',
      customWidth: width,
      customHeight: height,
    });
  },

  reset: () => {
    set({
      mode: 'split',
      scale: 1,
      devicePreset: 'desktop',
      customWidth: 1280,
      customHeight: 720,
    });
  },
}));
