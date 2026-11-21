import { useEffect } from 'react';

/** Announce confirmed storage once per format in each editor tab, including after a reload. */
export function useCompilerOfflineNotice(editor: 'studio' | 'builder', show: (message: string) => void): void {
  useEffect(() => {
    const confirmed = (event: Event) => {
      const format = (event as CustomEvent<unknown>).detail;
      if (format !== 'jsx' && format !== 'vue') return;
      const key = `softn.${editor}.compiler-notice.${format}`;
      try {
        if (sessionStorage.getItem(key)) return;
        sessionStorage.setItem(key, '1');
      } catch {
        // The installer also deduplicates acknowledgements within this page.
      }
      show(format === 'jsx' ? 'JSX is ready to edit offline.' : 'Vue components are ready to edit offline.');
    };
    window.addEventListener('softn:compiler-offline-ready', confirmed);
    return () => window.removeEventListener('softn:compiler-offline-ready', confirmed);
  }, [editor, show]);
}
