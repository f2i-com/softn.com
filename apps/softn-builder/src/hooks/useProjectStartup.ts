import { useEffect, useRef } from 'react';
import { startupAction, SESSION_STORAGE_KEY, type StartupAction } from '../utils/openProject';
import { readLocalStorage } from '../utils/safeStorage';

/** Consume a startup link once, but restart its request after effect cleanup.
 * React StrictMode replays effects in development. Re-reading the URL on that
 * replay loses the consumed link; suppressing the replay loses the aborted request.
 * Synchronous restore/refusal prompts, however, must only run once.
 */
export function useProjectStartup(run: (action: StartupAction) => void | (() => void)): void {
  const actionRef = useRef<StartupAction | null>(null);
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    const action = actionRef.current ?? startupAction(window.location, window.history, readLocalStorage(SESSION_STORAGE_KEY));
    actionRef.current = action.kind === 'remote-open' ? action : { kind: 'nothing' };
    if (action.kind === 'nothing') return;
    return runRef.current(action);
  }, []);
}
