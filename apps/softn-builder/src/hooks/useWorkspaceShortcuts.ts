import { useEffect, useRef } from 'react';
import type { ViewMode } from '../utils/openProject';
import { ownsTextKeys, redoCanvas, undoCanvas } from '../utils/canvasHistory';
import { moveSelected, type KeyboardMove } from '../utils/keyboardMoves';
import { useCanvasStore } from '../stores/canvasStore';
import { focusPanel } from '../utils/panelFocus';

/**
 * Move the selected element and leave the focus on it. An element moved to
 * another container is drawn again there, and the focus it had goes to the
 * page: the next arrow would have been pressed into nothing.
 */
function moveSelectedAndKeepFocus(step: KeyboardMove): void {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const inHierarchy = active?.closest('[data-hierarchy-row]') != null;
  moveSelected(step);
  const [id] = useCanvasStore.getState().selectedIds;
  if (!id) return;
  requestAnimationFrame(() => {
    const now = document.activeElement;
    if (now instanceof HTMLElement && now !== document.body && now.isConnected && now === active) return;
    const selector = inHierarchy ? `[data-hierarchy-row="${id}"]` : `[data-canvas-element-id="${id}"]`;
    document.querySelector<HTMLElement>(selector)?.focus({ preventScroll: false });
  });
}

export interface WorkspaceShortcutActions {
  blocked: boolean;
  narrow: boolean;
  /** Whether the canvas is on the screen: Design, with a page open. */
  canvas?: boolean;
  save: () => void;
  open: () => void;
  create: () => void;
  export: () => void;
  shortcuts: () => void;
  changeView: (view: ViewMode) => void;
}

/** Keys that are held with another, and are no key of a chord on their own. */
const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Shift', 'Alt']);

export function useWorkspaceShortcuts(actions: WorkspaceShortcutActions) {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  useEffect(() => {
    // Whether the last key, in a code editor, was Ctrl+K: the code editor's
    // chord, whose second key may be Ctrl and a digit (fold to that level).
    let chordStarted = false;
    const keyDown = (event: KeyboardEvent) => {
      const current = actionsRef.current;
      let inChord = false;
      if (!MODIFIER_KEYS.has(event.key)) {
        inChord = chordStarted;
        chordStarted = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && event.target instanceof HTMLElement && event.target.closest('.monaco-editor') !== null;
      }
      if (event.isComposing || current.blocked) return;
      // F6 goes to the next panel and Shift+F6 to the one before, a code
      // editor included: Tab indents there, and stopped there for good.
      if (event.key === 'F6' && !event.altKey && !event.ctrlKey && !event.metaKey) {
        const from = event.target instanceof HTMLElement ? event.target : null;
        if (current.narrow || from?.closest('[role="dialog"][aria-modal="true"]')) return;
        if (focusPanel(event.shiftKey ? -1 : 1)) {
          event.preventDefault(); event.stopPropagation();
        }
        return;
      }
      if (event.altKey) {
        // Alt+Shift and an arrow moves the selected element, wherever the
        // focus is while the canvas is on the screen: nothing but a drag
        // did. Alt alone with Up or Down too; Alt with Left or Right is the
        // browser's Back and Forward, and is left to it.
        const moves: Record<string, KeyboardMove> = { ArrowUp: 'up', ArrowDown: 'down', ArrowRight: 'in', ArrowLeft: 'out' };
        const step = moves[event.key];
        const vertical = step === 'up' || step === 'down';
        if (!step || event.ctrlKey || event.metaKey || !(event.shiftKey || vertical)) return;
        if (!current.canvas || current.narrow) return;
        const from = event.target instanceof HTMLElement ? event.target : null;
        if (ownsTextKeys(from) || from?.closest('[role="dialog"][aria-modal="true"], select')) return;
        event.preventDefault(); event.stopPropagation();
        if (!event.repeat || vertical) moveSelectedAndKeepFocus(step);
        return;
      }
      const target = event.target instanceof HTMLElement ? event.target : null;
      const isInput = !!target?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]');
      const key = event.key.toLowerCase();
      // Feature dialogs mounted inside a workspace panel do not participate
      // in App's top-level modal state. Their draft still owns the keyboard.
      if (target?.closest('[role="dialog"][aria-modal="true"]')) {
        if ((event.ctrlKey || event.metaKey) && ((!event.shiftKey && ['s', 'o', 'n'].includes(key)) || (event.shiftKey && key === 'e'))) {
          event.preventDefault(); event.stopPropagation();
        }
        return;
      }
      if (event.ctrlKey || event.metaKey) {
        // Save and Open belong to the workspace, including while typing in Monaco.
        // Capture phase prevents the browser's Save Page dialog taking the keystroke.
        const fileAction = !event.shiftKey && key === 's' ? current.save
          : !event.shiftKey && key === 'o' ? current.open
          : !current.narrow && !event.shiftKey && key === 'n' ? current.create
          : !current.narrow && event.shiftKey && key === 'e' ? current.export : null;
        if (fileAction) {
          event.preventDefault(); event.stopPropagation();
          if (!event.repeat) {
            // Schema names commit on blur. A keyboard save/export must see
            // the same completed name as a click on the toolbar does.
            if (target?.matches('[data-schema-name]')) target.blur();
            fileAction();
          }
          return;
        }
        // Undo and redo step the canvas wherever the focus is while the
        // canvas is on the screen: they were heard only inside the canvas,
        // so after picking an element in the hierarchy, or adding one from
        // the palette, Ctrl+Z did nothing. A field being typed in, and the
        // code editor, keep their own.
        if (current.canvas && !current.narrow && !ownsTextKeys(target) && (key === 'z' || (key === 'y' && !event.shiftKey))) {
          event.preventDefault(); event.stopPropagation();
          if (key === 'z' && !event.shiftKey) undoCanvas();
          else redoCanvas();
          return;
        }
        if (current.narrow || event.shiftKey) return;
        // Heard wherever the focus is: no field and no code editor uses
        // them for text, and from the Code view, where the focus is in the
        // editor, Ctrl+1 did nothing (and the browser took it, for its first
        // tab). The code editor's own use of them, as the second key of its
        // Ctrl+K chord, is left to it.
        const views: Record<string, ViewMode> = { '1': 'design', '2': 'data', '3': 'preview', '4': 'code' };
        if (views[key] && !inChord) {
          event.preventDefault();
          // A schema name commits on blur, as for Save above.
          if (target?.matches('[data-schema-name]')) target.blur();
          current.changeView(views[key]);
        }
      } else if (key === '?' && !isInput && !current.narrow) {
        event.preventDefault(); current.shortcuts();
      }
    };
    window.addEventListener('keydown', keyDown, true);
    return () => window.removeEventListener('keydown', keyDown, true);
  }, []);
}
