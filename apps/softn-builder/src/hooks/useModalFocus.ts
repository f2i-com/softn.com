import { useEffect, useRef } from 'react';

/** Give a modal keyboard ownership and return focus to its opener on close. */
export function useModalFocus(isOpen: boolean, onClose: () => void, initialSelector?: string) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const items = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]'
    )).filter(item => !item.closest('[hidden], [inert]') && getComputedStyle(item).display !== 'none');
    const initial = (initialSelector ? dialog.querySelector<HTMLElement>(initialSelector) : null) ?? items()[0] ?? dialog;
    initial.focus();
    if (initial instanceof HTMLInputElement) initial.select();
    const keyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); closeRef.current();
      } else if (event.key === 'Tab') {
        const focusable = items();
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first) { event.preventDefault(); dialog.focus(); return; }
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !dialog.contains(active))) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
          event.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener('keydown', keyDown, true);
    return () => {
      document.removeEventListener('keydown', keyDown, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [isOpen, initialSelector]);
  return dialogRef;
}
