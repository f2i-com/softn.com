import { keepOfflineAssets } from '@softn/bundle-format/offline-assets';

const retained = new Map<string, Promise<void>>();

/** On the first use of a syntax, retain its compiler across reloads and service-worker updates. */
export function keepSourceCompiler(format: 'jsx' | 'vue'): Promise<void> {
  if (!import.meta.env.PROD || import.meta.env.VITE_FORMLOGIC_EDITOR === '1' ||
    import.meta.env.TAURI_ENV_PLATFORM || !globalThis.navigator?.serviceWorker) return Promise.resolve();
  const saved = retained.get(format);
  if (saved) return saved;
  const saving = keepOfflineAssets({ type: 'SOFTN_KEEP_COMPILER', format })
    .then(() => { window.dispatchEvent(new CustomEvent('softn:compiler-offline-ready', { detail: format })); })
    .catch((error) => {
      retained.delete(format);
      throw error;
    });
  retained.set(format, saving);
  return saving;
}
