/**
 * Which side panels are open beside the canvas at a given window width.
 *
 * The Design view is four columns: Files, Components, the canvas and
 * Properties. Three of them have a fixed width and the canvas takes what is
 * left. All three were open wherever they left the canvas 360 pixels, which
 * at 1440 was a canvas of 540 between 860 pixels of panels, and at 1024 one
 * of 370: the page being built was the smallest thing on the screen.
 *
 * The canvas now keeps the room a page needs, and the panels share what is
 * over ({@link layoutMode}):
 *
 *   all     every panel, where the canvas still has {@link CANVAS_WIDE}.
 *   two     Properties, and one of Files and Components: opening one of
 *           those two puts the other away to its rail.
 *   one     one panel of the three at a time.
 *   sheets  no panel beside the canvas at all: a phone or a narrow tablet,
 *           where the canvas keeps the screen and each panel is a sheet
 *           opened over it (App.tsx).
 *
 * A panel put away for want of room comes back with the room; one a person
 * closed stays closed, and one they opened stays open until its room is
 * needed by another they open.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The widths of the Design row, which App.tsx and the Files panel lay out
 * from: a panel, the rail it closes to, and the row's own padding with the
 * gaps between its four columns.
 */
export const PANEL_WIDTHS = { files: 280, components: 260, properties: 320, rail: 34, around: 16 + 3 * 8 } as const;
const { files: FILES, components: COMPONENTS, properties: PROPERTIES, rail: RAIL, around: AROUND } = PANEL_WIDTHS;

/** The least the canvas keeps beside Properties and one more panel. */
export const CANVAS_MIN = 560;
/** The least the canvas keeps beside all three panels. */
export const CANVAS_WIDE = 760;
/** Below this the panels are sheets over the canvas, and none stands beside it. */
export const SHEETS_BELOW = 900;

export type PanelId = 'files' | 'components' | 'properties';
export type LayoutMode = 'sheets' | 'one' | 'two' | 'all';
export type PanelsOpen = Record<PanelId, boolean>;

const PANELS: readonly PanelId[] = ['components', 'properties', 'files'];
const WIDTH: Record<PanelId, number> = { files: FILES, components: COMPONENTS, properties: PROPERTIES };

/** How many panels the window has room for, as the name of the arrangement. */
export function layoutMode(width: number): LayoutMode {
  if (width < SHEETS_BELOW) return 'sheets';
  if (width >= FILES + COMPONENTS + PROPERTIES + AROUND + CANVAS_WIDE) return 'all';
  // The wider of the two that share the left place, so either may be the one open.
  if (width >= RAIL + Math.max(FILES, COMPONENTS) + PROPERTIES + AROUND + CANVAS_MIN) return 'two';
  return 'one';
}

/** What is left for the canvas at `width` with these panels open and the others at their rails. */
export function canvasWidthWith(width: number, open: PanelsOpen): number {
  return width - AROUND - PANELS.reduce((sum, panel) => sum + (open[panel] ? WIDTH[panel] : RAIL), 0);
}

/** Whether `a` and `b` cannot both be open in this arrangement. */
function crowd(mode: LayoutMode, a: PanelId, b: PanelId): boolean {
  if (a === b || mode === 'all') return false;
  if (mode === 'two') return a !== 'properties' && b !== 'properties';
  return true;
}

interface PanelState {
  open: PanelsOpen;
  /** Put away for want of room, not by the person: these come back with the room. */
  forRoom: PanelsOpen;
  /** The panels in the order a person last opened them, the latest first. */
  recent: readonly PanelId[];
}

const NONE: PanelsOpen = { files: false, components: false, properties: false };

/**
 * The panels as an arrangement leaves them: what was put away for room is
 * opened again where it now fits, and of two that crowd each other the one
 * opened later stays.
 */
export function fitPanels(mode: LayoutMode, state: PanelState): PanelState {
  if (mode === 'sheets') return state;
  const open = { ...state.open };
  const forRoom = { ...state.forRoom };
  // Latest first: each keeps its place against those opened before it.
  const kept: PanelId[] = [];
  for (const panel of state.recent) {
    if (!open[panel] && !forRoom[panel]) continue;
    if (kept.some((other) => crowd(mode, panel, other))) {
      if (open[panel]) forRoom[panel] = true;
      open[panel] = false;
    } else {
      open[panel] = true;
      forRoom[panel] = false;
      kept.push(panel);
    }
  }
  return { open, forRoom, recent: state.recent };
}

/** The panels a window of this width starts with: all of them, as far as there is room. */
export function panelsThatFit(width: number): PanelsOpen {
  const mode = layoutMode(width);
  if (mode === 'sheets') return NONE;
  return fitPanels(mode, { open: { files: true, components: true, properties: true }, forRoom: NONE, recent: PANELS }).open;
}

export interface WorkspaceLayout {
  mode: LayoutMode;
  /** The panels open beside the canvas. None is, where they are sheets. */
  open: PanelsOpen;
  setOpen: (panel: PanelId, open: boolean) => void;
}

/** The arrangement of the window as it is, and the panels open in it. */
export function useWorkspaceLayout(): WorkspaceLayout {
  const [mode, setMode] = useState(() => layoutMode(window.innerWidth));
  // Begun as the narrowest arrangement with panels where there are none yet, so a window that
  // widens out of sheets finds every panel waiting for its room.
  const [state, setState] = useState<PanelState>(() =>
    fitPanels(mode === 'sheets' ? 'one' : mode, { open: { files: true, components: true, properties: true }, forRoom: NONE, recent: PANELS })
  );
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    const check = () => {
      const next = layoutMode(window.innerWidth);
      if (next === modeRef.current) return;
      modeRef.current = next;
      setMode(next);
      setState((previous) => fitPanels(next, previous));
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const setOpen = useCallback((panel: PanelId, open: boolean) => {
    setState((previous) => {
      const recent = open ? [panel, ...previous.recent.filter((other) => other !== panel)] : previous.recent;
      const next: PanelState = {
        open: { ...previous.open, [panel]: open },
        // Opened or closed by the person: it is as they left it, not waiting for room.
        forRoom: { ...previous.forRoom, [panel]: false },
        recent,
      };
      return open ? fitPanels(modeRef.current, next) : next;
    });
  }, []);

  return { mode, open: mode === 'sheets' ? NONE : state.open, setOpen };
}
