import type { Plugin } from 'vite';

export interface SoftnPwaOptions {
  disable?: boolean;
  registerType?: 'autoUpdate' | 'prompt';
  injectRegister?: 'script' | false;
  /** Accepted for vite-plugin-pwa's configs; the globs already take the icons. */
  includeManifestIcons?: boolean;
  manifest: Record<string, unknown>;
  workbox?: {
    globPatterns?: string[];
    globIgnores?: string[];
    maximumFileSizeToCacheInBytes?: number;
    importScripts?: string[];
    runtimeCaching?: Array<{
      urlPattern: RegExp;
      handler: 'CacheFirst' | 'NetworkFirst';
      options?: {
        cacheName?: string;
        networkTimeoutSeconds?: number;
        expiration?: { maxEntries?: number; maxAgeSeconds?: number };
        cacheableResponse?: { statuses?: number[] };
      };
    }>;
  };
}

export function softnPwa(options: SoftnPwaOptions): Plugin;
