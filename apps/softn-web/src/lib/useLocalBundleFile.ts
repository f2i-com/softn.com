import { useCallback, useEffect, useRef } from 'react';
import { readLocalBundle } from './localBundle';

/** Archive and folder opens share the same navigation and unmount checks. */
export function useLocalBundleFile(
  onFile: (data: Uint8Array, fileName: string, isForeground: () => boolean) => void | Promise<void>,
  onError: (error: Error) => void,
  claimNavigation: () => () => boolean,
): (source: File | File[]) => Promise<void> {
  const selection = useRef(0);
  useEffect(() => () => { selection.current += 1; }, []);
  return useCallback(async (source: File | File[]) => {
    const request = ++selection.current;
    const ownsNavigation = claimNavigation();
    const isForeground = () => request === selection.current && ownsNavigation();
    try {
      const bundle = Array.isArray(source)
        ? await (await import('./localWebFolder')).readLocalWebFolder(source)
        : { data: await readLocalBundle(source), fileName: source.name };
      if (isForeground()) await onFile(bundle.data, bundle.fileName, isForeground);
    } catch (error) {
      if (isForeground()) {
        onError(error instanceof Error ? error : new Error('This app could not be opened.'));
      }
    }
  }, [onFile, onError, claimNavigation]);
}
