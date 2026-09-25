import { useEffect, useState } from 'react';
import { listModels, type ModelInfo } from '../../lib/providerConnection';
import type { ProviderConfig } from '../../types/studio';

type ModelsState = { state: 'idle' | 'loading' } | { state: 'ok'; models: ModelInfo[] } | { state: 'error'; message: string };

/**
 * Lists, kept for the session by what they were fetched with — the same
 * provider, address and key — so opening Settings twice asks the provider
 * once. A changed key or address is a different entry.
 */
const cache = new Map<string, Promise<ModelInfo[]>>();

function cacheKey(provider: ProviderConfig): string {
  return JSON.stringify([provider.id, provider.type, provider.baseUrl ?? '', provider.apiKey, provider.orgId ?? '']);
}

/** Forget the cached lists (tests; a provider removed). */
export function clearModelListCache(): void {
  cache.clear();
}

/** The models a provider offers, fetched once per session and shared. */
export function useProviderModels(provider: ProviderConfig | null | undefined): ModelsState {
  const [state, setState] = useState<ModelsState>({ state: 'idle' });
  const key = provider ? cacheKey(provider) : null;
  useEffect(() => {
    if (!provider || !key) {
      setState({ state: 'idle' });
      return;
    }
    let live = true;
    let pending = cache.get(key);
    if (!pending) {
      pending = listModels(provider);
      cache.set(key, pending);
      // A failure is not kept: the next look tries again.
      pending.catch(() => cache.delete(key));
    }
    setState({ state: 'loading' });
    pending.then(
      (models) => { if (live) setState({ state: 'ok', models }); },
      (err: unknown) => { if (live) setState({ state: 'error', message: err instanceof Error ? err.message : String(err) }); },
    );
    return () => { live = false; };
    // The key covers every field of the provider the list depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}
