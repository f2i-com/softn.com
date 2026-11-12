import { useEffect, useRef } from 'react';
import { startupAction, SESSION_STORAGE_KEY, type StartupAction } from '../utils/openProject';
import { readLocalStorage } from '../utils/safeStorage';
import { isVisitWorkspace, readTabVisit, sessionWorkspace, writeTabVisit } from '../utils/studioLink';
import { studioOffered } from '../utils/studioVisit';
import { isHostedEditor } from '@softn/editor-shared/hostedEditor';

/** Consume a startup link once, but restart its request after effect cleanup.
 * React StrictMode replays effects in development. Re-reading the URL on that
 * replay loses the consumed link; suppressing the replay loses the aborted request.
 * Synchronous restore/refusal prompts, however, must only run once. So must a
 * start that has to do with Studio: nothing aborts it, and it goes on by itself.
 */
export function useProjectStartup(run: (action: StartupAction) => void | (() => void)): void {
  const actionRef = useRef<StartupAction | null>(null);
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (isHostedEditor()) return;
    let action = actionRef.current;
    if (!action) {
      const stored = readLocalStorage(SESSION_STORAGE_KEY);
      // Where there is a Studio beside this Builder, the start is told what it left here (utils/studioLink.ts).
      const tab = studioOffered() ? readTabVisit() : null;
      const visitSession = studioOffered() && isVisitWorkspace(sessionWorkspace(stored)?.workspace ?? null);
      action = startupAction(window.location, window.history, stored, { tab, visitSession });
      // A link followed in a tab that was on a visit: the tab is on the link's project now, and a reload stays there.
      if (tab && action.kind !== 'from-studio') writeTabVisit(null);
    }
    actionRef.current = action.kind === 'remote-open' ? action : { kind: 'nothing' };
    if (action.kind === 'nothing') return;
    return runRef.current(action);
  }, []);
}
