import { useEffect } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { isDesktop } from '../utils/desktop';
import { toast } from '../stores/notificationStore';

/** Read the live store at navigation time, including edits made in another panel. */
export function useUnsavedChanges(): void {
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!useProjectStore.getState().isDirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let asking = false;
    if (isDesktop()) {
      void Promise.all([import('@tauri-apps/api/window'), import('@tauri-apps/plugin-dialog')])
        .then(async ([{ getCurrentWindow }, { ask }]) => {
          if (disposed) return;
          const appWindow = getCurrentWindow();
          const stop = await appWindow.onCloseRequested(async (event) => {
            const { isDirty, projectId, revision } = useProjectStore.getState();
            if (!isDirty || disposed) return;
            event.preventDefault();
            if (asking) return;
            asking = true;
            try {
              const discard = await ask('Close Builder and discard unsaved changes? Save your app first to keep them.',
                { title: 'Unsaved changes', kind: 'warning', okLabel: 'Discard and close', cancelLabel: 'Keep editing' });
              const current = useProjectStore.getState();
              // The answer is for the revision shown when the dialog opened.
              if (discard && !disposed && current.projectId === projectId && current.revision === revision) {
                await appWindow.destroy();
              }
            } catch {
              toast.error('Could not close the window. Your app is still open.');
            } finally {
              asking = false;
            }
          });
          if (disposed) stop(); else unlisten = stop;
        }).catch(() => toast.error('The desktop close guard could not start. Save your app before closing.'));
    }
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, []);
}
