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

  it.each([
    ['example.com:8080/docs', 'https://example.com:8080/docs'],
    ['localhost:3000', 'https://localhost:3000'],
    ['intranet:8443?page=2', 'https://intranet:8443?page=2'],
    ['tel:5551234', 'tel:5551234'],
    ['mailto:ada@example.com', 'mailto:ada@example.com'],
  ])('reads %s as %s: a name and a port is a web address, not a scheme', (typed, href) => {
    // "example.com:8080" was read as a scheme named example.com and refused.
    const { field } = editorWithSelection();
    type(field!, typed);
    press(field!, 'Enter');
    expect(exec).toHaveBeenCalledWith('createLink', false, href);
  });

  it.each([
    ['a control character before a scheme', String.fromCharCode(1) + 'javascript:alert(1)'],
    ['a scheme and nothing after it', 'https://'],
    ['a port that is not one', 'example.com:99999999/x'],
  ])('refuses %s, which is no address at all', (_, typed) => {
    // Given https:// in front these were links nothing could follow.
    const { field } = editorWithSelection();
    type(field!, typed);
    press(field!, 'Enter');
    expect(exec).not.toHaveBeenCalledWith('createLink', expect.anything(), expect.anything());
    expect(view!.container.querySelector('[role="alert"]')).not.toBeNull();
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
    // The caret stays by the link: a sanitiser that changed the link's
    // markup made the editor rewrite itself, and the caret went to its start.
    const caret = document.getSelection()!;
    expect(editor.querySelector('p')!.contains(caret.anchorNode)).toBe(true);
  });

  it('does not hold up the form the editor is in over an address it would take', () => {
    // The field was a `type="url"` input, which the browser checks for
    // itself: "example.com" is an address here (it is given https://), not
    // one to the browser, so with the field open the form around the editor
    // would not submit, and the browser pointed at a field that is no part
    // of what the form sends.
    view = mount(
      <form>
        <RichTextEditor defaultValue="<p>Hello world</p>" />
      </form>
    );
    act(() => view!.container.querySelector<HTMLButtonElement>('button[aria-label="Link"]')!.click());
    const field = view.container.querySelector<HTMLInputElement>('input[aria-label="Link address"]')!;
    type(field, 'example.com');
    expect(view.container.querySelector('form')!.checkValidity()).toBe(true);
    // Still the keyboard for an address where there is one on screen.
    expect(field.getAttribute('inputmode')).toBe('url');
  });

  it('closes the field when pressed again, with the selection it opened on still there', () => {
    // It says `aria-expanded`, and it only opened again: from there the
    // selection it read was the field's own, the one in the editor was
    // forgotten, and the link was put at the end of the text.
    const { editor } = editorWithSelection();
    const link = view!.container.querySelector<HTMLButtonElement>('button[aria-label="Link"]')!;
    expect(link.getAttribute('aria-expanded')).toBe('true');
    act(() => link.click());
    expect(view!.container.querySelector('input[aria-label="Link address"]')).toBeNull();
    expect(link.getAttribute('aria-expanded')).toBe('false');
    expect(document.getSelection()?.toString()).toBe('world');
    // Opened once more, it links what was selected.
    act(() => link.click());
    const field = view!.container.querySelector<HTMLInputElement>('input[aria-label="Link address"]')!;
    type(field, 'https://example.com');
    press(field, 'Enter');
    expect(exec).toHaveBeenCalledWith('createLink', false, 'https://example.com');
    expect(editor.querySelector('a')).toBeNull();
  });

  it.each(['readOnly', 'disabled'] as const)('makes no link in an editor that became %s while the field was open', (how) => {
    const onChange = vi.fn();
    view = mount(<RichTextEditor defaultValue="<p>See </p>" onChange={onChange} />);
    const editor = view.container.querySelector<HTMLElement>('[role="textbox"]')!;
    act(() => view!.container.querySelector<HTMLButtonElement>('button[aria-label="Link"]')!.click());
    type(view.container.querySelector<HTMLInputElement>('input[aria-label="Link address"]')!, 'https://example.com');
    view.rerender(<RichTextEditor defaultValue="<p>See </p>" onChange={onChange} {...{ [how]: true }} />);
    // The field goes with the buttons; pressed anyway, it changes nothing.
    const field = view.container.querySelector<HTMLInputElement>('input[aria-label="Link address"]');
    if (field) press(field, 'Enter');
    expect(field).toBeNull();
    expect(editor.querySelector('a')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});

/**
 * The value is a record's field, written by whoever wrote the record. An
 * address in it that a click would run is not a link once it is in the
 * editor, however it is spelled; one a person would follow still is.
 */
describe('a link in the value the editor is given', () => {
  it.each([
    ['javascript:alert(1)'],
    ['JaVaScRiPt:alert(1)'],
    ['  javascript:alert(1)'],
    ['jav&#x09;ascript:alert(1)'],
    ['jav&#10;ascript:alert(1)'],
    ['&#1;javascript:alert(1)'],
    ['&#106;avascript:alert(1)'],
    ['&#x6A;avascript&colon;alert(1)'],
    ['vbscript:msgbox(1)'],
    ['data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;'],
  ])('has no address when it is %s', (address) => {
    view = mount(<RichTextEditor value={`<p>See <a href="${address}">this</a></p>`} />);
    const editor = view.container.querySelector<HTMLElement>('[role="textbox"]')!;
    const anchor = editor.querySelector('a');
    expect(anchor?.textContent).toBe('this');
    expect(anchor?.hasAttribute('href')).toBe(false);
    expect(editor.innerHTML).not.toMatch(/script|data:/i);
  });

  it.each(['https://example.com/a?b=1#c', 'mailto:ada@example.com', 'tel:+15551234', '/docs/start', '#top'])('keeps %s', (address) => {
    view = mount(<RichTextEditor value={`<p>See <a href="${address}">this</a></p>`} />);
    const anchor = view.container.querySelector('[role="textbox"] a');
    expect(anchor?.getAttribute('href')).toBe(address);
  });

  it('carries no handler, frame or form into the editor', () => {
    view = mount(
      <RichTextEditor value={'<p onclick="alert(1)">a</p><img src="x" onerror="alert(1)"><iframe srcdoc="<script>alert(1)</script>"></iframe><form action="javascript:alert(1)"><button formaction="javascript:alert(1)">go</button></form><svg onload="alert(1)"><a xlink:href="javascript:alert(1)">s</a></svg>'} />
    );
    const editor = view.container.querySelector<HTMLElement>('[role="textbox"]')!;
    expect(editor.querySelectorAll('iframe, form, button, svg, script')).toHaveLength(0);
    const attributes = Array.from(editor.querySelectorAll('*')).flatMap((element) => element.getAttributeNames());
    expect(attributes.filter((name) => name.startsWith('on') || name === 'srcdoc' || name === 'formaction' || name === 'action')).toEqual([]);
    expect(editor.innerHTML).not.toMatch(/javascript:/i);
  });
});
