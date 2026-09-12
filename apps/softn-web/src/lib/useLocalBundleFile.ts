import { useCallback, useEffect, useRef } from 'react';
import { readLocalBundle } from './localBundle';

/** A newer selection or an unmounted picker must not open an older file later. */
export function useLocalBundleFile(
  onFile: (data: Uint8Array, fileName: string) => void | Promise<void>,
  onError: (error: Error) => void,
): (file: File) => Promise<void> {
  const selection = useRef(0);
  useEffect(() => () => { selection.current += 1; }, []);
  return useCallback(async (file: File) => {
    const request = ++selection.current;
    try {
      const data = await readLocalBundle(file);
      if (request === selection.current) await onFile(data, file.name);
    } catch (error) {
      if (request === selection.current) {
        onError(error instanceof Error ? error : new Error('This app could not be opened.'));
      }
    }
  }, [onFile, onError]);
}
