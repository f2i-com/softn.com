import { useSyncExternalStore } from 'react';
import { hostedSaveLabel, subscribeHostedSaveLabel } from './hostedEditor';

/**
 * The host's name for saving back to it (hostedSaveLabel), kept current: null
 * until a host that sends one opens a project, and again once it goes.
 */
export function useHostedSaveLabel(): string | null {
  return useSyncExternalStore(subscribeHostedSaveLabel, hostedSaveLabel, () => null);
}
