/**
 * Which side panels are open beside the canvas at a given window width.
 *
 * The Design view is four columns: Files, Components, the canvas and
 * Properties. Three of them have a fixed width and the canvas takes what is
 * left, which at 900 pixels, the narrowest window the editor is shown in,
 * was nothing: the canvas, its tabs and the logic dock were not on the
 * screen at all, and nothing said that hiding a panel would bring them
 * back. A panel there is no room for now starts as its rail, the canvas
 * keeping at least {@link CANVAS_MIN}, and comes back when the window grows.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** The least width the canvas column is left with. */
export const CANVAS_MIN = 360;

/**
 * The widths of the Design row, which App.tsx and the Files panel lay out
 * from: a panel, the rail it closes to, and the row's own padding with the
 * gaps between its four columns.
 */
export const PANEL_WIDTHS = { files: 280, components: 260, properties: 320, rail: 34, around: 16 + 3 * 8 } as const;
const { files: FILES, components: COMPONENTS, properties: PROPERTIES, rail: RAIL, around: AROUND } = PANEL_WIDTHS;

export interface PanelFit {
  files: boolean;
  components: boolean;
}

/** The panels there is room for at `width`. Files gives way first; Properties stays. */
export function panelsThatFit(width: number): PanelFit {
  const withBoth = FILES + COMPONENTS + PROPERTIES + AROUND + CANVAS_MIN;
  const withComponents = RAIL + COMPONENTS + PROPERTIES + AROUND + CANVAS_MIN;
  return { files: width >= withBoth, components: width >= withComponents };
}

/** The panels there is room for in the window as it is now. */
export function usePanelsThatFit(): PanelFit {
  const [fit, setFit] = useState(() => panelsThatFit(window.innerWidth));
  useEffect(() => {
    const check = () => {
      const next = panelsThatFit(window.innerWidth);
      setFit((prev) => (prev.files === next.files && prev.components === next.components ? prev : next));
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  return fit;
}

/** What is left for the canvas at `width` with these panels open. */
export function canvasWidthWith(width: number, open: PanelFit): number {
  return width - (open.files ? FILES : RAIL) - (open.components ? COMPONENTS : RAIL) - PROPERTIES - AROUND;
}

/**
 * The least the canvas is ever left with. A person may open a panel the
 * window has no comfortable room for, and work on a narrower canvas; they
 * may not open the canvas away altogether, which both panels do at once.
 */
export const CANVAS_FLOOR = 200;

/**
 * Files and Components, open or shut, in the window as it is: each as
 * {@link useFittedDock} keeps it, and never both where that would leave the
 * canvas less than {@link CANVAS_FLOOR}: opening one closes the other.
 */
export function useSidePanels(): {
  files: boolean;
  components: boolean;
  setFiles: (open: boolean) => void;
  setComponents: (open: boolean) => void;
} {
  const fit = usePanelsThatFit();
  const [files, chooseFiles, closeFiles] = useFittedDock(fit.files);
  const [components, chooseComponents, closeComponents] = useFittedDock(fit.components);
  const both = () => canvasWidthWith(window.innerWidth, { files: true, components: true }) >= CANVAS_FLOOR;
  const setFiles = useCallback((open: boolean) => {
    chooseFiles(open);
    if (open && !both()) closeComponents();
  }, [chooseFiles, closeComponents]);
  const setComponents = useCallback((open: boolean) => {
    chooseComponents(open);
    if (open && !both()) closeFiles();
  }, [chooseComponents, closeFiles]);
  return { files, components, setFiles, setComponents };
}

/**
 * Whether a panel is open, given whether there is room for it. It closes
 * when the room goes and opens again when the room is back, unless the
 * person closed it themselves; and it stays as they set it until then.
 * The third thing returned closes it for room, as a narrowing window does.
 */
export function useFittedDock(fits: boolean): [boolean, (open: boolean) => void, () => void] {
  const [open, setOpen] = useState(fits);
  const closedForRoom = useRef(!fits);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    if (!fits) {
      if (openRef.current) closedForRoom.current = true;
      setOpen(false);
    } else if (closedForRoom.current) {
      closedForRoom.current = false;
      setOpen(true);
    }
  }, [fits]);

  const choose = useCallback((next: boolean) => {
    closedForRoom.current = false;
    setOpen(next);
  }, []);
  /** Closed to make room, not by choice: it comes back with the room. */
  const closeForRoom = useCallback(() => {
    if (openRef.current) closedForRoom.current = true;
    setOpen(false);
  }, []);
  return [open, choose, closeForRoom];
}
