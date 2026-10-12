/**
 * RichTextEditor's Link button asks for the address in a field of its own.
 *
 * It called `prompt()`, which a sandboxed frame (how FormLogic and the web
 * runtime run apps) does not allow: the button did nothing there. The field
 * keeps the text that was selected when it opened, links it on Enter, and
 * gives the editor back its focus and selection on Escape without closing a
 * dialog the editor sits in. Only a web, mail or phone address is linked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { mount, type, type Mounted } from './dom';
import { RichTextEditor } from '../src/editors/RichTextEditor';

let view: Mounted | null = null;
let exec: ReturnType<typeof vi.fn>;
beforeEach(() => {
  exec = vi.fn(() => true);
  Object.defineProperty(document, 'execCommand', { value: exec, configurable: true, writable: true });
  vi.spyOn(window, 'prompt').mockImplementation(() => {
    throw new Error('prompt() is blocked in a sandboxed frame');
  });
});
afterEach(() => {
  view?.unmount();
  view = null;
  vi.restoreAllMocks();
});

function press(element: Element, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

/** The editor with "Hello world" in it and "world" selected. */
function editorWithSelection() {
  view = mount(<RichTextEditor defaultValue="<p>Hello world</p>" />);
  const editor = view.container.querySelector<HTMLElement>('[role="textbox"]')!;
  const text = editor.querySelector('p')!.firstChild!;
  const range = document.createRange();
  range.setStart(text, 6);
  range.setEnd(text, 11);
  act(() => {
    editor.focus();
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  const link = view.container.querySelector<HTMLButtonElement>('button[aria-label="Link"]')!;
  act(() => link.click());
  const field = view.container.querySelector<HTMLInputElement>('input[aria-label="Link address"]');
  return { editor, field };
}

describe('the Link button', () => {
  it('opens a field for the address, not a prompt, and puts focus in it', () => {
    const { field } = editorWithSelection();
    expect(window.prompt).not.toHaveBeenCalled();
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
  });

  it('links the text that was selected when Enter is pressed', () => {
    const { editor, field } = editorWithSelection();
    type(field!, 'https://example.com/docs');
    press(field!, 'Enter');
    expect(exec).toHaveBeenCalledWith('createLink', false, 'https://example.com/docs');
    // The selection was put back before the link was made.
    expect(document.getSelection()?.toString()).toBe('world');
    expect(editor.contains(document.getSelection()!.anchorNode)).toBe(true);
    expect(view!.container.querySelector('input[aria-label="Link address"]')).toBeNull();
  });

  it('reads an address without a scheme as a web address', () => {
    const { field } = editorWithSelection();
    type(field!, 'example.com');
    press(field!, 'Enter');
    expect(exec).toHaveBeenCalledWith('createLink', false, 'https://example.com');
  });

  it('refuses an address that is not a web, mail or phone one, and says so', () => {
    const { field } = editorWithSelection();
    type(field!, 'javascript:alert(1)');
    press(field!, 'Enter');
    expect(exec).not.toHaveBeenCalledWith('createLink', expect.anything(), expect.anything());
    expect(view!.container.querySelector('[role="alert"]')?.textContent).toMatch(/web, mail or phone/);
    expect(view!.container.querySelector('input[aria-label="Link address"]')).not.toBeNull();
  });

  it('closes on Escape, gives the editor its focus back, and keeps the Escape from anything around it', () => {
    const { editor, field } = editorWithSelection();
    // jsdom does not focus a contenteditable element; that the editor is asked to is what can be seen here.
    const focused = vi.spyOn(editor, 'focus');
    const escape = press(field!, 'Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(view!.container.querySelector('input[aria-label="Link address"]')).toBeNull();
    expect(focused).toHaveBeenCalled();
    expect(document.getSelection()?.toString()).toBe('world');
    expect(exec).not.toHaveBeenCalledWith('createLink', expect.anything(), expect.anything());
  });

  it('inserts the address as its own link where nothing was selected', () => {
    view = mount(<RichTextEditor defaultValue="<p>See </p>" />);
    const editor = view.container.querySelector<HTMLElement>('[role="textbox"]')!;
    const text = editor.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 4);
    range.collapse(true);
    act(() => {
      editor.focus();
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    act(() => view!.container.querySelector<HTMLButtonElement>('button[aria-label="Link"]')!.click());
    const field = view.container.querySelector<HTMLInputElement>('input[aria-label="Link address"]')!;
    type(field, 'https://example.com');
    press(field, 'Enter');
    const anchor = editor.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://example.com');
    expect(anchor?.textContent).toBe('https://example.com');
  });
});
