import { useEffect, useRef } from 'react';
import type { ViewMode } from '../utils/openProject';

export interface WorkspaceShortcutActions {
  blocked: boolean;
  narrow: boolean;
  save: () => void;
  open: () => void;
  create: () => void;
  export: () => void;
  shortcuts: () => void;
  changeView: (view: ViewMode) => void;
}

export function useWorkspaceShortcuts(actions: WorkspaceShortcutActions) {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      const current = actionsRef.current;
      if (event.isComposing || current.blocked || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const isInput = !!target?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]');
      const key = event.key.toLowerCase();
      if (event.ctrlKey || event.metaKey) {
        // Save and Open belong to the workspace, including while typing in Monaco.
        // Capture phase prevents the browser's Save Page dialog taking the keystroke.
        const fileAction = !event.shiftKey && key === 's' ? current.save
          : !event.shiftKey && key === 'o' ? current.open
          : !current.narrow && !event.shiftKey && key === 'n' ? current.create
          : !current.narrow && event.shiftKey && key === 'e' ? current.export : null;
        if (fileAction) {
          event.preventDefault(); event.stopPropagation();
          if (!event.repeat) fileAction();
          return;
        }
        if (isInput || current.narrow || event.shiftKey) return;
        const views: Record<string, ViewMode> = { '1': 'design', '2': 'data', '3': 'preview', '4': 'code' };
        if (views[key]) { event.preventDefault(); current.changeView(views[key]); }
      } else if (key === '?' && !isInput && !current.narrow) {
        event.preventDefault(); current.shortcuts();
      }
    };
    window.addEventListener('keydown', keyDown, true);
    return () => window.removeEventListener('keydown', keyDown, true);
  }, []);
}
