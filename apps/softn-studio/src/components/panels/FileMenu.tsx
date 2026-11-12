import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Glyph, type GlyphName } from './fileGlyphs';

/**
 * The menu of a row in the Files panel, and of the panel's empty space.
 *
 * It is opened three ways and is the same menu each time: by a right-click,
 * where the pointer is; by a row's "more" button, the only way on a touch
 * screen, under the button; and from the keyboard (the menu key, or
 * Shift+F10), under the row. It is a menu in the ARIA sense: the items are
 * `menuitem`s, the arrow keys, Home and End move between them, a letter goes
 * to the next item that starts with it, Escape closes and gives the focus
 * back, and a press outside closes.
 *
 * An item that cannot be chosen just now stays in the menu, marked
 * `aria-disabled`, with the reason as its title, so the menu is the same list
 * whatever the moment and says why a thing is not on offer.
 */

export interface FileMenuItem {
  id: string;
  label: string;
  glyph: GlyphName;
  /** The keys that do the same, shown beside it where there is a keyboard. */
  keys?: string;
  danger?: boolean;
  /** Why it cannot be chosen now; absent when it can. */
  disabled?: string | null;
  /** A rule above it: the start of another group. */
  group?: boolean;
  onSelect(): void;
}

export interface FileMenuPlace {
  x: number;
  y: number;
}

interface FileMenuProps {
  /** What the menu is for, said to a screen reader and shown at its top: a path, or "Project files". */
  title: string;
  items: FileMenuItem[];
  place: FileMenuPlace;
  /** A line above the items: why some of them are off. */
  note?: string | null;
  /** `restoreFocus`: Escape or a choice, where the focus goes back to what opened the menu. */
  onClose(restoreFocus: boolean): void;
}

const EDGE = 8;

export const FileMenu: React.FC<FileMenuProps> = ({ title, items, place, note, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number }>({ left: place.x, top: place.y });

  // Kept inside the window: opened near the right or the bottom edge, it moves in.
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    const left = Math.max(EDGE, Math.min(place.x, window.innerWidth - width - EDGE));
    const top = Math.max(EDGE, Math.min(place.y, window.innerHeight - height - EDGE));
    setAt((was) => (was.left === left && was.top === top ? was : { left, top }));
  }, [place.x, place.y, items.length]);

  // The panel draws again while the menu is up (a file changes, a notice goes): what closes the
  // menu is always the newest `onClose`, and the menu is set up once, not at each of those.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const menu = ref.current;
    menu?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (menu?.contains(target)) return;
      // The button that opened it closes it itself: closed here as well, its click would open it again.
      if (target?.closest?.('[data-menu-opener][aria-expanded="true"]')) return;
      close.current(false);
    };
    const away = () => close.current(false);
    // The tree scrolled under the menu: the row it is for is no longer where the menu points.
    // Only the tree, or what the panel is in: the log filling up beside it is no reason to close.
    const onScroll = (event: Event) => {
      const target = event.target as Node | null;
      const panel = document.querySelector('.st-files');
      if (!target || !panel || menu?.contains(target)) return;
      if (panel.contains(target) || target.contains(panel)) close.current(false);
    };
    // Capture, so a press on a row closes the menu before the row acts on it.
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', away);
    window.addEventListener('blur', away);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', away);
      window.removeEventListener('blur', away);
    };
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // The tree under the menu has keys of its own: none of these are for it.
    event.stopPropagation();
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      onClose(true);
      return;
    }
    const list = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (list.length === 0) return;
    const index = list.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (event.key === 'ArrowDown') next = (index + 1) % list.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + list.length) % list.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = list.length - 1;
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ') {
      const letter = event.key.toLowerCase();
      const from = index + 1;
      for (let step = 0; step < list.length; step++) {
        const candidate = (from + step) % list.length;
        if (list[candidate].textContent?.trim().toLowerCase().startsWith(letter)) {
          next = candidate;
          break;
        }
      }
    }
    if (next < 0) return;
    event.preventDefault();
    list[next].focus();
  };

  const menu = (
    <div
      ref={ref}
      className="st-fmenu"
      role="menu"
      aria-label={`Actions for ${title}`}
      style={{ left: at.left, top: at.top }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      // A paste or a click inside the menu is the menu's, not the panel's it is drawn from.
      onPaste={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <p className="st-fmenu-title" aria-hidden="true">{title}</p>
      {note && <p className="st-fmenu-note">{note}</p>}
      {items.map((item) => (
        <React.Fragment key={item.id}>
          {item.group && <div className="st-fmenu-sep" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className="st-fmenu-item"
            data-item={item.id}
            data-danger={item.danger ? 'true' : undefined}
            aria-disabled={item.disabled ? true : undefined}
            title={item.disabled ?? undefined}
            onClick={() => {
              if (item.disabled) return;
              onClose(true);
              item.onSelect();
            }}
          >
            <Glyph name={item.glyph} />
            <span className="st-fmenu-label">{item.label}</span>
            {item.keys && <span className="st-fmenu-key" aria-hidden="true">{item.keys}</span>}
          </button>
        </React.Fragment>
      ))}
    </div>
  );

  // Over everything, from the page's own root: the panel clips what is drawn inside it.
  return createPortal(menu, document.getElementById('root') ?? document.body);
};
