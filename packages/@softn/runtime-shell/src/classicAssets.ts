import { keepOfflineAssets } from '@softn/bundle-format/offline-assets';

export function keepClassicAssets(groups: string[], signal?: AbortSignal): Promise<void> {
  return keepOfflineAssets({ type: 'SOFTN_KEEP_CLASSIC', groups }, signal);
}
