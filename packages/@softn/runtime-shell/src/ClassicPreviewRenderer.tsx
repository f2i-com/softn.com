import { useCallback } from 'react';
import { collectAllComponentTags, getDefaultRegistry, SoftNWithXDB, type SoftNWithXDBProps, type SoftNDocument } from '@softn/core';
import { keepClassicAssets } from './classicAssets';

/** Keep the groups this preview can draw, including components behind a branch. */
export function ClassicPreviewRenderer({ onLoad, ...props }: SoftNWithXDBProps) {
  const loaded = useCallback((document: SoftNDocument) => {
    onLoad?.(document);
    if (!import.meta.env.PROD || import.meta.env.VITE_FORMLOGIC_EDITOR === '1' || import.meta.env.TAURI_ENV_PLATFORM || !navigator.serviceWorker) return;
    const registry = getDefaultRegistry();
    const groups = new Set<string>();
    for (const tag of collectAllComponentTags(document)) {
      const name = registry.resolveName(tag);
      const feature = name && registry.getFeature(name);
      if (feature) groups.add(feature);
    }
    void keepClassicAssets([...groups]).catch((error) => console.warn('Could not save the classic preview for offline use.', error));
  }, [onLoad]);
  return <SoftNWithXDB {...props} onLoad={loaded} />;
}
