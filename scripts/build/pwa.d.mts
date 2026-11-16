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
    /** Installed too, by address: files outside the app's own output. No revision for an address that changes with its content. */
    additionalManifestEntries?: Array<{ url: string; revision?: string | null }>;
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
