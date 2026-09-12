import { useEffect } from 'react';
import { useProjectStore } from '../stores/projectStore';

/** Read the live store at navigation time, including edits made in another panel. */
export function useUnsavedChanges(): void {
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!useProjectStore.getState().isDirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
}
