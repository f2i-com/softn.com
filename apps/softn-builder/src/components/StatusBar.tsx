/**
 * StatusBar - the row under the workspace: what is on the page and what is
 * selected, the file in hand, the way to the keyboard shortcuts, and the
 * messages (feedback/ToastContainer.tsx), which are shown here and nowhere
 * else: this row is the one part of the screen that is not a control, so a
 * message in it covers nothing.
 *
 * Its look is in styles/builder.css, under "Status bar and messages". The
 * row measures itself there, so it fits the room it is given, not the
 * window's: its own things give way to a message, the hint first, then the
 * file's path, then the counts.
 */

import { useLayoutEffect, useRef } from 'react';
import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { ToastContainer } from './feedback/ToastContainer';

interface StatusBarProps {
  onShortcuts: () => void;
  /**
   * A dialog is open over the page: the bar's own things are out of reach,
   * as the page's are. A message is still shown and its buttons still work;
   * the bar stands above the dialog's shade for as long as it holds one.
   */
  modalOpen?: boolean;
}

export function StatusBar({ onShortcuts, modalOpen = false }: StatusBarProps) {
  const selectedCount = useCanvasStore((state) => state.selectedIds.length);
  // The page's own <App> is not one of its elements: an empty page said "1 element".
  const elementCount = useCanvasStore((state) => state.elements.size - (state.elements.has(state.rootId) ? 1 : 0));
  const activePath = useFilesStore((state) => (state.activeFileId ? state.nodes.get(state.activeFileId)?.path : undefined));
  const hidden = modalOpen || undefined;

  // How far the top of the bar is from the bottom of the window: the strip a
  // dialog leaves free (builder.css, .bl-overlay), so a message shown above
  // the dialog's shade never lies on the dialog. The bar is the last row of
  // a wide window and has the bar of panels under it on a phone, so the
  // strip is measured, not known: it changes when the bar's height does or
  // when what is above the bar is given more or less of the window.
  const barRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const root = document.documentElement;
    const measure = () => {
      const room = Math.max(0, Math.round(window.innerHeight - bar.getBoundingClientRect().top));
      root.style.setProperty('--bl-status-room', `${room}px`);
    };
    measure();
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(bar);
    if (bar.previousElementSibling) observer?.observe(bar.previousElementSibling);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
      root.style.removeProperty('--bl-status-room');
    };
  }, []);

  return (
    <div ref={barRef} className="bl-status" data-modal={modalOpen ? '' : undefined}>
      <span className="bl-status-counts" aria-hidden={hidden}>
        <span>
          <strong>{elementCount}</strong> {elementCount === 1 ? 'element' : 'elements'}
        </span>
        <span>
          <strong>{selectedCount}</strong> selected
        </span>
      </span>
      {activePath && (
        <span className="bl-status-path" title={activePath} aria-hidden={hidden}>{activePath}</span>
      )}
      <ToastContainer modalOpen={modalOpen} />
      <button type="button" className="bl-status-hint" onClick={onShortcuts} disabled={modalOpen} aria-hidden={hidden}>
        Press <kbd className="bl-kbd">?</kbd> for keyboard shortcuts
      </button>
    </div>
  );
}
