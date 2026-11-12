import React, { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * A place in the page for the notices that otherwise float over it.
 *
 * The service worker's notices (PWAPrompt) are drawn in a dock fixed to a
 * corner of the window, and a screen whose controls are along its bottom edge
 * has them covered by it: on a phone the brief's "Studio is ready to work
 * offline" lay on Next and Generate. A screen like that draws a NoticeSlot
 * where a notice can stand in the flow of the page, above its bar of actions,
 * and while one is there the dock is drawn inside it: the page gives the
 * notice room, and nothing is under it.
 */

const slots: HTMLElement[] = [];
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The slot notices are drawn in now: the one drawn last, or null when the page has none. */
export function useNoticeSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slots[slots.length - 1] ?? null, () => null);
}

export const NoticeSlot: React.FC = () => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    slots.push(node);
    changed();
    return () => {
      const at = slots.indexOf(node);
      if (at >= 0) slots.splice(at, 1);
      changed();
    };
  }, []);
  return <div ref={ref} className="st-notice-slot" />;
};
