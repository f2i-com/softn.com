/**
 * Round 4's second reading of the editors: a toolbar pressed while the text it
 * edits is not on the screen, a drag whose markup was replaced under it, and a
 * JSON key typed straight after another string.
 */

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CapabilityProvider, type CapabilityState } from '@softn/core';
import { mount, click, type Mounted } from './dom';
import { tokenize } from '../src/editors/highlight';
import { CodeEditor } from '../src/editors/CodeEditor';
import { MarkdownEditor } from '../src/editors/MarkdownEditor';
import { RichTextEditor } from '../src/editors/RichTextEditor';

const views: Mounted[] = [];
function view(element: React.ReactElement): Mounted {
  const mounted = mount(element);
  views.push(mounted);
  return mounted;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  for (const mounted of views.splice(0)) mounted.unmount();
  delete (document as { execCommand?: unknown }).execCommand;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** jsdom has no `execCommand`; a browser's, as the test needs it. */
function defineExecCommand<T extends (...args: never[]) => boolean>(fn: T): T {
  Object.defineProperty(document, 'execCommand', { value: fn, configurable: true, writable: true });
  return fn;
}

const setTextareaValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;

/**
 * A browser's `insertText`: typed into whichever text field has focus, at
 * its selection, with `input` raised. It does not ask which field the page
 * meant.
 */
function insertTextIntoFocused(command: string, _ui?: boolean, value?: string): boolean {
  const field = document.activeElement;
  if (command !== 'insertText' || value === undefined) return false;
  if (!(field instanceof HTMLTextAreaElement) && !(field instanceof HTMLInputElement)) return false;
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  const next = field.value.slice(0, start) + value + field.value.slice(end);
  (field instanceof HTMLTextAreaElement ? setTextareaValue : setInputValue).call(field, next);
  field.setSelectionRange(start + value.length, start + value.length);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

// --- MarkdownEditor -----------------------------------------------------------------

describe('MarkdownEditor toolbar in preview mode', () => {
  it('makes its edit in its own text, and types nothing into the field that has the focus', () => {
    // Round 3 made toolbar edits with `insertText`, which types where the
    // focus is. In preview mode the text area is not drawn, a browser does
    // not focus it, and the focus stayed where it was (Safari and Firefox on
    // a Mac leave it there when a button is pressed): "**world**" was typed
    // into the page's other field.
    vi.useFakeTimers();
    const onChange = vi.fn();
    defineExecCommand(vi.fn(insertTextIntoFocused));
    const { container } = view(
      <>
        <input aria-label="Title" defaultValue="" />
        <MarkdownEditor defaultValue="Hello world" onChange={onChange} viewMode="preview" />
      </>
    );
    const title = container.querySelector<HTMLInputElement>('input[aria-label="Title"]')!;
    const textarea = container.querySelector('textarea')!;
    // An element that is not being rendered cannot be focused; jsdom draws
    // nothing and does not know that.
    textarea.focus = () => {};
    act(() => title.focus());
    act(() => textarea.setSelectionRange(6, 11));
    click(container.querySelector('button[aria-label="Bold"]'));
    act(() => vi.runAllTimers());
    expect(title.value).toBe('');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('Hello **world**');
    expect(textarea.value).toBe('Hello **world**');
  });

  it('still types the edit through the browser where the text area has the focus', () => {
    const onChange = vi.fn();
    const exec = defineExecCommand(vi.fn(insertTextIntoFocused));
    const { container } = view(<MarkdownEditor defaultValue="Hello world" onChange={onChange} viewMode="split" />);
    const textarea = container.querySelector('textarea')!;
    act(() => textarea.setSelectionRange(6, 11));
    click(container.querySelector('button[aria-label="Bold"]'));
    expect(exec).toHaveBeenCalledWith('insertText', false, '**world**');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe('Hello **world**');
  });
});

// --- RichTextEditor -----------------------------------------------------------------

const NO_NET: CapabilityState = { consentPending: false, permissions: {} };

/** Put `markup` where the selection is, as a browser's drop does with what it carries. */
function insertAtSelection(markup: string): void {
  const selection = document.getSelection()!;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const template = document.createElement('template');
  template.innerHTML = markup;
  range.insertNode(template.content);
}

/** A drop of `html` on the editor; where nothing takes it, the browser's: the markup as it came. */
function drop(editor: HTMLElement, html: string, text: string): Event {
  const event = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 40, clientY: 12 });
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      types: ['text/html', 'text/plain'],
      getData: (type: string) => (type === 'text/html' ? html : type === 'text/plain' ? text : ''),
      dropEffect: 'copy',
      effectAllowed: 'all',
      files: [],
    },
  });
  act(() => {
    editor.dispatchEvent(event);
  });
  if (!event.defaultPrevented) {
    act(() => {
      insertAtSelection(html);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromDrop' }));
    });
  }
  return event;
}

function placeCaretAtEnd(node: Node): void {
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  act(() => {
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
}

/** Images put on the page with a remote address: each was a request the moment it was attached. */
function remoteImages(records: MutationRecord[]): string[] {
  return records
    .flatMap((record) => Array.from(record.addedNodes))
    .flatMap((node) => (node instanceof Element ? [node, ...Array.from(node.querySelectorAll('*'))] : []))
    .filter((el) => el.tagName === 'IMG' && /^https?:/i.test(el.getAttribute('src') ?? ''))
    .map((el) => el.getAttribute('src')!);
}

describe('RichTextEditor, a drag whose markup was replaced while it went on', () => {
  it('cleans the next drop from outside, though the drag’s end never reached the editor', () => {
    // A drag that began in the editor marked its drop as the editor's own,
    // left to the browser, until its `dragend`. The value replaced the markup
    // while the drag went on (a synced edit), and the `dragend` went to the
    // node the drag began on, no longer in the editor: the mark stayed, and a
    // remote image dropped from another page later went in as it came.
    const draw = (value: string) => (
      <CapabilityProvider value={NO_NET}>
        <RichTextEditor value={value} onChange={() => {}} showToolbar={false} />
      </CapabilityProvider>
    );
    const { container, rerender } = view(draw('<p>Hello <b>big</b> world</p>'));
    const editor = container.querySelector<HTMLElement>('[role="textbox"]')!;
    const bold = editor.querySelector('b')!;
    act(() => {
      bold.dispatchEvent(new MouseEvent('dragstart', { bubbles: true }));
    });
    rerender(draw('<p>Changed in another tab</p>'));
    expect(editor.contains(bold)).toBe(false);
    act(() => {
      bold.dispatchEvent(new MouseEvent('dragend', { bubbles: true }));
    });

    defineExecCommand(vi.fn(() => false));
    placeCaretAtEnd(editor.querySelector('p')!);
    const observer = new MutationObserver(() => {});
    observer.observe(editor, { childList: true, subtree: true });
    const event = drop(editor, '<img src="https://tracker.example/p.png" alt="p">more', 'more');
    const records = observer.takeRecords();
    observer.disconnect();

    expect(event.defaultPrevented).toBe(true);
    expect(remoteImages(records)).toEqual([]);
    expect(editor.textContent).toBe('Changed in another tabmore');
  });

  it('still leaves a move of its own markup, still in it, to the browser', () => {
    const { container } = view(<RichTextEditor defaultValue="<p>Hello <b>big</b> world</p>" onChange={() => {}} showToolbar={false} />);
    const editor = container.querySelector<HTMLElement>('[role="textbox"]')!;
    act(() => {
      editor.querySelector('b')!.dispatchEvent(new MouseEvent('dragstart', { bubbles: true }));
    });
    const event = new MouseEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['text/html'], getData: (type: string) => (type === 'text/html' ? '<b>big</b>' : ''), files: [] },
    });
    act(() => {
      editor.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });
});

// --- highlight.ts -------------------------------------------------------------------

describe('a JSON key straight after another string', () => {
  it('keeps the string before it among the tokens', () => {
    // The key's string was merged into the string before it, and then that
    // token was replaced by the key alone: `"a"` was gone from the tokens,
    // which must join back to the text exactly.
    const source = '{"a""b": 1, "c"  "d" : 2}';
    const tokens = tokenize(source, 'json');
    expect(tokens.map((t) => t.text).join('')).toBe(source);
    expect(tokens.filter((t) => t.kind === 'property').map((t) => t.text)).toEqual(['"b"', '"d"']);
    expect(tokens.filter((t) => t.kind === 'string').map((t) => t.text)).toEqual(['"a"', '"c"']);
  });

  it('draws every character of the line under the CodeEditor’s text', () => {
    // The colours are drawn under the text the caret moves in: three
    // characters short, everything after them on the line was drawn three
    // places to the left of where it is typed.
    const value = '{"name""age": 3}';
    const { container } = view(<CodeEditor value={value} onChange={() => {}} language="json" />);
    expect(container.querySelector('[data-softn-code-highlight]')!.textContent).toBe(`${value}\n`);
  });
});
