import { useEffect, useRef } from 'react';

const nonEditingInputTypes = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);

function editsTextOrSelection(target: Element): boolean {
  if (target instanceof HTMLSelectElement) return !target.disabled;
  if (target instanceof HTMLTextAreaElement) return !target.disabled && !target.readOnly;
  if (target instanceof HTMLInputElement) return !target.disabled && !target.readOnly && !nonEditingInputTypes.has(target.type);
  const contentEditable = target.closest('[contenteditable]')?.getAttribute('contenteditable')?.toLowerCase();
  return contentEditable !== undefined && contentEditable !== 'false';
}

/** Give a modal keyboard ownership and return focus to its opener on close. */
export function useModalFocus(isOpen: boolean, onClose: () => void, initialSelector?: string) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    // React Flow edges are focusable SVG elements, while toolbar/list
    // openers are HTML. Both must get their keyboard position back.
    const active = document.activeElement;
    const opener = active instanceof HTMLElement || active instanceof SVGElement ? active : null;
    const items = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]'
    )).filter(item => !item.closest('[hidden], [inert]') && getComputedStyle(item).display !== 'none');
    const initial = (initialSelector ? dialog.querySelector<HTMLElement>(initialSelector) : null) ?? items()[0] ?? dialog;
    initial.focus();
    if (initial instanceof HTMLInputElement) initial.select();
    const keyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if ((event.key === 'Backspace' || event.key === 'Delete') && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        const target = event.target instanceof Element ? event.target : null;
        if (target && dialog.contains(target) && !editsTextOrSelection(target)) {
          // WebKit can treat Backspace on a button as browser Back. It must
          // also never reach the canvas's document-level deletion listener.
          event.preventDefault(); event.stopPropagation(); return;
        }
      }
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
