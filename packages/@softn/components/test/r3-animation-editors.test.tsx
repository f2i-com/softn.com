/**
 * The editors and the motion components, read again: what a page that
 * re-renders, a binding that hands a value back, a browser that reports its
 * own edits, a paste, a lost mouse release or a long line of text does to
 * them.
 */

import React, { Profiler, act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CapabilityProvider, type CapabilityState } from '@softn/core';
import { mount, click, type Mounted } from './dom';
import { tokenize, type CodeLanguage } from '../src/editors/highlight';
import { CodeEditor } from '../src/editors/CodeEditor';
import { RichTextEditor } from '../src/editors/RichTextEditor';
import { MarkdownEditor } from '../src/editors/MarkdownEditor';
import { SortableList } from '../src/animation/SortableList';
import { Draggable } from '../src/animation/Draggable';
import { PanView } from '../src/animation/PanView';
import { Sprite } from '../src/animation/Sprite';
import { AnimatedNumber } from '../src/animation/AnimatedNumber';
import { AnimatedBox } from '../src/animation/AnimatedBox';
import { Typewriter } from '../src/animation/Typewriter';
import { Marquee } from '../src/animation/Marquee';

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function key(el: Element, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
}

function pointer(
  target: EventTarget,
  type: string,
  init: MouseEventInit & { pointerId?: number; pointerType?: string } = {}
): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.assign(event, { pointerId: init.pointerId ?? 1, pointerType: init.pointerType ?? 'mouse' });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/** jsdom has no `execCommand`; a browser's, as the test needs it. */
function defineExecCommand<T extends (...args: never[]) => boolean>(fn: T): T {
  Object.defineProperty(document, 'execCommand', { value: fn, configurable: true, writable: true });
  return fn;
}

const setTextareaValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;

// --- highlight.ts ---------------------------------------------------------------

describe('the highlighter, on a long line of what never closes', () => {
  // A `[` with no `]` after it, a `<http://` with no `>`, a `/` that opens a
  // regular expression and a `[` inside it that never close, were each read
  // to the end of their line (or the text) again from every one of them: a
  // line of them took the square of its length, seconds of the page at a
  // couple of hundred kilobytes, on every keystroke in a CodeEditor.
  it.each<[CodeLanguage, string, string]>([
    ['markdown', '[ repeated', '['.repeat(100_000)],
    ['markdown', '[a]( repeated', '[a]('.repeat(50_000)],
    ['markdown', '![a]( repeated', '![a]('.repeat(40_000)],
    ['markdown', '<http:// repeated', '<http://'.repeat(25_000)],
    ['javascript', '(/[ repeated', '(/['.repeat(40_000)],
    ['typescript', '(/[ repeated', '(/['.repeat(40_000)],
    ['css', '[ repeated', '['.repeat(600_000)],
    ['shell', '[ on every line', '[\n'.repeat(500_000)],
    ['rust', '#[ on every line', '#[\n'.repeat(400_000)],
    ['javascript', 'words and spaces', 'a '.repeat(150_000)],
    ['python', 'words and spaces', 'a '.repeat(150_000)],
  ])('%s: %s is read in time that grows with its length', (language, _what, source) => {
    const started = performance.now();
    const tokens = tokenize(source, language);
    const elapsed = performance.now() - started;
    expect(tokens.map((t) => t.text).join('')).toBe(source);
    expect(elapsed).toBeLessThan(1500);
  });

  it('still reads the links, autolinks, regular expressions and attributes that do close', () => {
    const md = tokenize('a [x](y) ![i](j.png) <https://e.x/a> [no] (x) <http://open', 'markdown');
    expect(md.filter((t) => t.kind === 'function').map((t) => t.text)).toEqual(['[x](y)', '![i](j.png)', '<https://e.x/a>']);
    const js = tokenize('x = (/[/]\\//g); y = (/[ z / 2;\nw = /a/;', 'javascript');
    expect(js.filter((t) => t.kind === 'regex').map((t) => t.text)).toEqual(['/[/]\\//g', '/a/']);
    const css = tokenize('a[href] { b: c }\n[x\n]', 'css');
    expect(css.filter((t) => t.kind === 'attr').map((t) => t.text)).toEqual(['[href]', '[']);
  });
});

// --- CodeEditor -----------------------------------------------------------------

describe('CodeEditor', () => {
  it('leaves an Escape that ends an IME composition to the IME, and Tab still indents after it', () => {
    // The first Escape was taken (default prevented) to release Tab: one that
    // cancelled a conversion was eaten, and the next Tab left the editor.
    const { container } = view(<CodeEditor defaultValue={'x'} />);
    const textarea = container.querySelector('textarea')!;
    const escape = key(textarea, { key: 'Escape', isComposing: true });
    expect(escape.defaultPrevented).toBe(false);
    expect(key(textarea, { key: 'Tab' }).defaultPrevented).toBe(true);
    expect(textarea.value).toBe('  x');
  });

  it('does not take the Enter that commits a conversion, which Safari reports after the composition as key 229', () => {
    // It kept the line's indentation for it: committing a word typed with an
    // input method on an indented line also broke the line there.
    const { container } = view(<CodeEditor defaultValue={'    word'} />);
    const textarea = container.querySelector('textarea')!;
    textarea.setSelectionRange(8, 8);
    const enter = key(textarea, { key: 'Enter', keyCode: 229 });
    expect(enter.defaultPrevented).toBe(false);
    expect(textarea.value).toBe('    word');
  });

  it('redraws the line a keystroke changed, not every token after it', () => {
    // The colours were one list of every token in the file, keyed by place:
    // a keystroke that split or joined a token moved every token after it to
    // a new place, and every one of them was drawn again.
    const source = 'const value = compute(item.id, "text", 42); // note\n'.repeat(300);
    function Bound() {
      const [code, setCode] = React.useState(source);
      return <CodeEditor value={code} onChange={setCode} language="javascript" />;
    }
    const { container } = view(<Bound />);
    const layer = container.querySelector('[data-softn-code-highlight]')!;
    const textarea = container.querySelector('textarea')!;
    const observer = new MutationObserver(() => {});
    observer.observe(layer, { subtree: true, childList: true, characterData: true, attributes: true });
    act(() => {
      setTextareaValue.call(textarea, 'c ' + source.slice(1));
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const changes = observer.takeRecords().length;
    observer.disconnect();
    expect(layer.textContent).toBe(`c ${source.slice(1)}\n`);
    expect(layer.querySelectorAll('.softn-code-keyword')).toHaveLength(299);
    expect(changes).toBeLessThan(60);
  });
});

// --- RichTextEditor -------------------------------------------------------------

const NO_NET: CapabilityState = { consentPending: false, permissions: {} };

/** Put `markup` where the selection is, with the caret after it, as a browser's paste and insertHTML do. */
function insertAtSelection(markup: string): void {
  const selection = document.getSelection()!;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const template = document.createElement('template');
  template.innerHTML = markup;
  const last = template.content.lastChild;
  range.insertNode(template.content);
  const after = document.createRange();
  if (last) after.setStartAfter(last);
  else after.setStart(range.startContainer, range.startOffset);
  after.collapse(true);
  selection.removeAllRanges();
  selection.addRange(after);
}

/** A paste of `html`; where nothing takes it, what the browser then does with it. */
function paste(editor: HTMLElement, html: string, text = ''): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      types: html ? ['text/html', 'text/plain'] : ['text/plain'],
      getData: (type: string) => (type === 'text/html' ? html : type === 'text/plain' ? text : ''),
    },
  });
  act(() => {
    editor.dispatchEvent(event);
  });
  if (!event.defaultPrevented && html) {
    act(() => {
      insertAtSelection(html);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
    });
  }
  return event;
}

/**
 * A drop of `html` (and `text`) on the editor; where nothing takes it and
 * `browserDoes`, what the browser then does with it: the markup as it came,
 * where the drop landed.
 */
function drop(editor: HTMLElement, html: string, text = '', { browserDoes = true } = {}): Event {
  const event = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 40, clientY: 12 });
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      types: html ? ['text/html', 'text/plain'] : ['text/plain'],
      getData: (type: string) => (type === 'text/html' ? html : type === 'text/plain' ? text : ''),
      dropEffect: 'copy',
      effectAllowed: 'all',
      files: [],
    },
  });
  act(() => {
    editor.dispatchEvent(event);
  });
  if (!event.defaultPrevented && html && browserDoes) {
    act(() => {
      const at = (document as { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(40, 12);
      if (at) {
        const selection = document.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(at);
      }
      insertAtSelection(html);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromDrop' }));
    });
  }
  return event;
}

function placeCaret(node: Node, offset: number): void {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  act(() => {
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
}

function textBeforeCaret(editor: HTMLElement): string {
  const selection = document.getSelection()!;
  if (!selection.rangeCount || !editor.contains(selection.anchorNode)) return '(not in the editor)';
  const range = document.createRange();
  range.setStart(editor, 0);
  range.setEnd(selection.anchorNode!, selection.anchorOffset);
  return range.toString();
}

/** Images put on the page with a remote address: each was a request the moment it was attached. */
function remoteImages(records: MutationRecord[]): string[] {
  return records
    .flatMap((record) => Array.from(record.addedNodes))
    .flatMap((node) => (node instanceof Element ? [node, ...Array.from(node.querySelectorAll('*'))] : []))
    .filter((el) => el.tagName === 'IMG' && /^https?:/i.test(el.getAttribute('src') ?? ''))
    .map((el) => el.getAttribute('src')!);
}

describe('RichTextEditor', () => {
  it('reports a toolbar command or shortcut once when the browser raises input for it, as browsers do', () => {
    const onChange = vi.fn();
    const { container } = view(<RichTextEditor defaultValue="<p>Hello</p>" onChange={onChange} />);
    const editor = container.querySelector<HTMLElement>('[role="textbox"]')!;
    defineExecCommand(
      vi.fn(() => {
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'formatBold' }));
        return true;
      })
    );
    click(container.querySelector('button[aria-label="Bold"]'));
    expect(onChange).toHaveBeenCalledTimes(1);
    key(editor, { key: 'i', ctrlKey: true });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('still reports a command the browser carried out without raising input', () => {
    const onChange = vi.fn();
    const { container } = view(<RichTextEditor defaultValue="<p>Hello</p>" onChange={onChange} />);
    defineExecCommand(vi.fn(() => true));
    click(container.querySelector('button[aria-label="Italic"]'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('sanitizes a paste before it reaches the page, so nothing withheld is fetched and the caret stays after it', () => {
    // The browser pasted the markup as it came and the input handler cleaned
    // it afterwards: by then a remote image had been attached (a request
    // the bundle was not granted), and the cleaning rewrote the whole editor,
    // which took the caret to the start and the undo history with it.
    const onChange = vi.fn();
    const { container } = view(
      <CapabilityProvider value={NO_NET}>
        <RichTextEditor defaultValue="<p>Hello world</p>" onChange={onChange} showToolbar={false} />
      </CapabilityProvider>
    );
    const editor = container.querySelector<HTMLElement>('[role="textbox"]')!;
    const exec = defineExecCommand(
      vi.fn((command: string, _ui?: boolean, value?: string) => {
        if (command !== 'insertHTML' || value === undefined) return false;
        insertAtSelection(value);
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
        return true;
      })
    );
    placeCaret(editor.querySelector('p')!.firstChild!, 6);
    const observer = new MutationObserver(() => {});
    observer.observe(editor, { childList: true, subtree: true });
    const event = paste(
      editor,
      '<html><body><!--StartFragment--><section><img src="https://tracker.example/p.png" alt="p">big </section><!--EndFragment--></body></html>',
      'big '
    );
    const records = observer.takeRecords();
    observer.disconnect();

    expect(event.defaultPrevented).toBe(true);
    expect(remoteImages(records)).toEqual([]);
    expect(exec).toHaveBeenCalledWith('insertHTML', false, expect.not.stringMatching(/<section|\ssrc="https|StartFragment/));
    expect(textBeforeCaret(editor)).toBe('Hello big ');
    expect(editor.querySelector('section')).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.lastCall![0]).toBe(editor.innerHTML);
  });

  it('puts a paste in by hand where the browser will not, and leaves a paste of text to the browser', () => {
    const onChange = vi.fn();
    const { container } = view(<RichTextEditor defaultValue="<p>Hello world</p>" onChange={onChange} showToolbar={false} />);
    const editor = container.querySelector<HTMLElement>('[role="textbox"]')!;
    defineExecCommand(vi.fn(() => false));
    placeCaret(editor.querySelector('p')!.firstChild!, 6);
    paste(editor, '<b onclick="alert(1)">big</b> ');
    expect(editor.innerHTML).toBe('<p>Hello <b>big</b> world</p>');
    expect(textBeforeCaret(editor)).toBe('Hello big ');
    expect(onChange).toHaveBeenLastCalledWith('<p>Hello <b>big</b> world</p>');
    expect(paste(editor, '', 'plain').defaultPrevented).toBe(false);
  });

  it('reads the document no more under a binding that hands back what it reported than without one', () => {
    // The markup handed back by `:bind` after each keystroke was sanitized
    // again in full, to find it was what the editor already held.
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
    const keystroke = (editor: HTMLElement): number => {
      parse.mockClear();
      editor.querySelector('p')!.append('!');
      act(() => {
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      });
      return parse.mock.calls.length;
    };
    const free = view(<RichTextEditor defaultValue="<p>Hello</p>" onChange={() => {}} showToolbar={false} />);
    const unbound = keystroke(free.container.querySelector<HTMLElement>('[role="textbox"]')!);
    function Bound() {
      const [html, setHtml] = React.useState('<p>Hello</p>');
      return <RichTextEditor value={html} onChange={setHtml} showToolbar={false} />;
    }
    const bound = view(<Bound />);
    const editor = bound.container.querySelector<HTMLElement>('[role="textbox"]')!;
    expect(keystroke(editor)).toBe(unbound);
    expect(editor.innerHTML).toBe('<p>Hello!</p>');
  });

  it('sanitizes markup dropped on it from outside before it reaches the page, at the place it was dropped', () => {
    // A drop is a paste by another hand, and the browser dropped the markup
    // as it came: a remote image dragged in from another page was attached,
    // a request the bundle had not been granted, until the input handler
    // cleaned it afterwards.
    const onChange = vi.fn();
    const { container } = view(
      <CapabilityProvider value={NO_NET}>
        <RichTextEditor defaultValue="<p>Hello world</p>" onChange={onChange} showToolbar={false} />
      </CapabilityProvider>
    );
    const editor = container.querySelector<HTMLElement>('[role="textbox"]')!;
    defineExecCommand(
      vi.fn((command: string, _ui?: boolean, value?: string) => {
        if (command !== 'insertHTML' || value === undefined) return false;
        insertAtSelection(value);
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromDrop' }));
        return true;
      })
    );
    // Where the pointer let go: after "Hello ".
    const text = editor.querySelector('p')!.firstChild!;
    Object.defineProperty(document, 'caretRangeFromPoint', {
      configurable: true,
      value: () => {
        const range = document.createRange();
        range.setStart(text, 6);
        range.collapse(true);
        return range;
      },
    });
    const observer = new MutationObserver(() => {});
    observer.observe(editor, { childList: true, subtree: true });
    const event = drop(
      editor,
      '<html><body><!--StartFragment--><img src="https://tracker.example/p.png" alt="p">big <!--EndFragment--></body></html>',
      'big '
    );
    const records = observer.takeRecords();
    observer.disconnect();
    delete (document as { caretRangeFromPoint?: unknown }).caretRangeFromPoint;

    expect(remoteImages(records)).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
    expect(editor.querySelector('img[src^="https:"]')).toBeNull();
    expect(editor.textContent).toBe('Hello big world');
    expect(textBeforeCaret(editor)).toBe('Hello big ');
  });

  it('leaves a move of its own markup within it to the browser, and a drop of text', () => {
    // A drag from inside the editor is its own markup, cleaned already: the
    // browser's move keeps the undo history and takes the text from where
    // it was.
    const { container } = view(<RichTextEditor defaultValue="<p>Hello <b>big</b> world</p>" onChange={() => {}} showToolbar={false} />);
    const editor = container.querySelector<HTMLElement>('[role="textbox"]')!;
    act(() => {
      editor.querySelector('b')!.dispatchEvent(new MouseEvent('dragstart', { bubbles: true }));
    });
    expect(drop(editor, '<b>big</b>', 'big', { browserDoes: false }).defaultPrevented).toBe(false);
    act(() => {
      editor.querySelector('b')!.dispatchEvent(new MouseEvent('dragend', { bubbles: true }));
    });
    // Text from outside is the browser's too.
    expect(drop(editor, '', 'plain', { browserDoes: false }).defaultPrevented).toBe(false);
    // Once the move is over, markup from outside is not taken for its own.
    defineExecCommand(vi.fn(() => false));
    expect(drop(editor, '<i>more</i>', 'more', { browserDoes: false }).defaultPrevented).toBe(true);
  });

  it('reports a drop from outside once', () => {
    // The browser raises `input` for what insertHTML put in, and that is the
    // report; reported again after it, one drop was two changes.
    const onChange = vi.fn();
    const { container } = view(<RichTextEditor defaultValue="<p>Hello</p>" onChange={onChange} showToolbar={false} />);
    const editor = container.querySelector<HTMLElement>('[role="textbox"]')!;
    defineExecCommand(
      vi.fn((command: string, _ui?: boolean, value?: string) => {
        if (command !== 'insertHTML' || value === undefined) return false;
        insertAtSelection(value);
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromDrop' }));
        return true;
      })
    );
    placeCaret(editor.querySelector('p')!.firstChild!, 5);
    drop(editor, '<b>!</b>', '!', { browserDoes: false });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('<p>Hello<b>!</b></p>');
  });

  it('shows no placeholder over a value that is an image and nothing else', () => {
    const { container } = view(<RichTextEditor value={'<p><img src="/map.png" alt="Map"></p>'} showToolbar={false} />);
    expect(container.textContent).not.toContain('Start writing...');
    expect(container.querySelector('[role="textbox"]')!.getAttribute('aria-placeholder')).toBeNull();
  });
});

// --- MarkdownEditor ---------------------------------------------------------------

/** A browser's `insertText`: the focused field's selection is replaced and `input` raised, on the undo stack. */
function insertTextLikeABrowser(command: string, _ui?: boolean, value?: string): boolean {
  const field = document.activeElement;
  if (command !== 'insertText' || value === undefined || !(field instanceof HTMLTextAreaElement)) return false;
  const { selectionStart: start, selectionEnd: end } = field;
  setTextareaValue.call(field, field.value.slice(0, start) + value + field.value.slice(end));
  field.setSelectionRange(start + value.length, start + value.length);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

describe('MarkdownEditor', () => {
  it('makes a toolbar edit through the browser’s own editing, so Ctrl+Z can take it back', () => {
    // The new text was set as the field's value, which a browser does not
    // keep on its undo stack and which emptied the stack besides.
    const onChange = vi.fn();
    const exec = defineExecCommand(vi.fn(insertTextLikeABrowser));
    const { container } = view(<MarkdownEditor defaultValue="Hello world" onChange={onChange} viewMode="edit" />);
    const textarea = container.querySelector('textarea')!;
    act(() => textarea.setSelectionRange(6, 11));
    click(container.querySelector('button[aria-label="Bold"]'));
    expect(exec).toHaveBeenCalledWith('insertText', false, expect.any(String));
    expect(textarea.value).toBe('Hello **world**');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('Hello **world**');
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([8, 13]);
  });

  it('still makes the edit where the browser cannot', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { container } = view(<MarkdownEditor defaultValue="Hello world" onChange={onChange} viewMode="edit" />);
    const textarea = container.querySelector('textarea')!;
    act(() => textarea.setSelectionRange(6, 11));
    click(container.querySelector('button[aria-label="Code"]'));
    act(() => vi.runAllTimers());
    expect(textarea.value).toBe('Hello `world`');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([7, 12]);
  });

  it('draws nothing into the preview it hides in edit mode, and the preview once it is shown', () => {
    // The hidden preview was converted and sanitized on every keystroke, the
    // whole cost of the editor, and its images were fetched unseen.
    const { container, rerender } = view(<MarkdownEditor value="![x](/a.png)" viewMode="edit" />);
    const preview = container.querySelector('[role="region"][aria-label="Preview"]')!;
    expect(preview.querySelector('img')).toBeNull();
    rerender(<MarkdownEditor value="![x](/a.png)" viewMode="split" />);
    expect(preview.querySelector('img')?.getAttribute('src')).toBe('/a.png');
  });
});

// --- SortableList -----------------------------------------------------------------

const fruit = [
  { id: 'a', name: 'Apple' },
  { id: 'b', name: 'Banana' },
  { id: 'c', name: 'Cherry' },
];

function pointerReady(item: HTMLElement): HTMLElement {
  Object.assign(item, { setPointerCapture: () => {}, hasPointerCapture: () => false, releasePointerCapture: () => {} });
  item.getBoundingClientRect = () => ({ height: 40, width: 200 }) as DOMRect;
  return item;
}

describe('SortableList', () => {
  it('is not picked up by a right-click', () => {
    // Any button began a drag, and the context menu took the release.
    const onReorder = vi.fn();
    const { container } = view(<SortableList items={fruit} renderKey="id" primary="name" onReorder={onReorder} />);
    const item = pointerReady(container.querySelectorAll<HTMLElement>('[role="listitem"]')[0]);
    pointer(item, 'pointerdown', { clientY: 0, button: 2, buttons: 2 });
    pointer(item, 'pointermove', { clientY: 100, buttons: 2 });
    pointer(item, 'pointerup', { clientY: 100, button: 2 });
    expect(onReorder).not.toHaveBeenCalled();
    expect(item.style.transform).toBe('');
  });

  it('follows the pointer without drawing the list again until the slot it would drop into changes', () => {
    // Every pointer move set state, and the whole list was drawn again for
    // each: sixty times a second for a list of any length.
    let commits = 0;
    const onReorder = vi.fn();
    const { container } = view(
      <Profiler id="list" onRender={() => commits++}>
        <SortableList items={fruit} renderKey="id" primary="name" onReorder={onReorder} />
      </Profiler>
    );
    const item = pointerReady(container.querySelectorAll<HTMLElement>('[role="listitem"]')[0]);
    pointer(item, 'pointerdown', { clientY: 0, buttons: 1 });
    commits = 0;
    for (let y = 1; y <= 20; y++) pointer(item, 'pointermove', { clientY: y, buttons: 1 });
    expect(item.style.transform).toBe('translate(0px, 20px) scale(1.02)');
    expect(commits).toBe(0);
    pointer(item, 'pointermove', { clientY: 30, buttons: 1 });
    expect(commits).toBe(1);
    const second = container.querySelectorAll<HTMLElement>('[role="listitem"]')[1];
    expect(second.style.transform).toBe('translateY(-48px)');
    expect(item.style.transform).toBe('translate(0px, 30px) scale(1.02)');
    pointer(item, 'pointerup', { clientY: 30 });
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect((onReorder.mock.calls[0][0] as typeof fruit).map((f) => f.name)).toEqual(['Banana', 'Apple', 'Cherry']);
    expect(item.style.transform).toBe('');
  });

  it('does not move an item a click barely jiggled when its gap is not a number', () => {
    // A gap of NaN made every slot NaN, and a drop at slot NaN put the item
    // first: the pointer moving a pixel during a click reordered the list.
    const onReorder = vi.fn();
    const { container } = view(<SortableList items={fruit} renderKey="id" primary="name" gap={Number.NaN} onReorder={onReorder} />);
    const item = pointerReady(container.querySelectorAll<HTMLElement>('[role="listitem"]')[2]);
    pointer(item, 'pointerdown', { clientY: 0, buttons: 1 });
    pointer(item, 'pointermove', { clientY: 1, buttons: 1 });
    pointer(item, 'pointerup', { clientY: 1 });
    expect(onReorder).not.toHaveBeenCalled();
    expect((container.firstElementChild as HTMLElement).style.gap).toBe('8px');
  });
});

// --- Marquee ----------------------------------------------------------------------

describe('Marquee', () => {
  it('does not measure its content again each time the page around it is drawn', () => {
    // Its measuring effect depended on `children`, a new value at every
    // draw: each one took down its ResizeObserver, made a new one and read
    // the content's width, a layout, though the observer reports any change.
    let observers = 0;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor() {
          observers++;
        }
        observe() {}
        disconnect() {}
      }
    );
    const { rerender } = view(
      <Marquee>
        <span>News</span>
      </Marquee>
    );
    const made = observers;
    for (let i = 0; i < 5; i++) {
      rerender(
        <Marquee>
          <span>News</span>
        </Marquee>
      );
    }
    expect(observers).toBe(made);
  });
});

// --- Draggable --------------------------------------------------------------------

describe('Draggable', () => {
  it('is not dragged by a right-click', () => {
    const onDragStart = vi.fn();
    const onDrag = vi.fn();
    const { container } = view(
      <Draggable onDragStart={onDragStart} onDrag={onDrag}>
        <div>card</div>
      </Draggable>
    );
    const el = container.firstElementChild as HTMLElement;
    pointer(el, 'pointerdown', { button: 2, buttons: 2 });
    pointer(document, 'pointermove', { clientX: 40, buttons: 2 });
    expect(onDragStart).not.toHaveBeenCalled();
    expect(onDrag).not.toHaveBeenCalled();
    expect(el.style.transform).toBe('');
  });

  it('lets go when the mouse moves with no button held, where the release went somewhere it could not hear', () => {
    // Released outside the window, or while a menu or another app had the
    // mouse, the drag never ended: the element followed the cursor with no
    // button held until the next click.
    const onDrag = vi.fn();
    const onDragEnd = vi.fn();
    const { container } = view(
      <Draggable onDrag={onDrag} onDragEnd={onDragEnd}>
        <div>card</div>
      </Draggable>
    );
    const el = container.firstElementChild as HTMLElement;
    pointer(el, 'pointerdown', { button: 0, buttons: 1, clientX: 0, clientY: 0 });
    pointer(document, 'pointermove', { buttons: 1, clientX: 30, clientY: 0 });
    expect(onDrag).toHaveBeenLastCalledWith({ x: 30, y: 0 });
    pointer(document, 'pointermove', { buttons: 0, clientX: 60, clientY: 0 });
    expect(onDragEnd).toHaveBeenCalledTimes(1);
    expect(onDragEnd).toHaveBeenCalledWith({ x: 30, y: 0 });
    pointer(document, 'pointermove', { buttons: 0, clientX: 90, clientY: 0 });
    expect(onDrag).toHaveBeenCalledTimes(1);
    expect(el.style.transform).toBe('translate(30px, 0px)');
    expect(el.style.cursor).toBe('grab');
  });
});

// --- PanView ----------------------------------------------------------------------

describe('PanView', () => {
  it('still re-centres on a resize after the app zoomed a view the user never moved', () => {
    // The zoom kept the middle in the middle, and the view then no longer
    // matched where it had been put, so it was taken for one the user had
    // panned: resizing the panel stopped re-centring it.
    const observed: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          observed.push(callback);
        }
        observe() {}
        disconnect() {}
      }
    );
    const size = (el: HTMLElement, width: number, height: number) => {
      Object.defineProperty(el, 'clientWidth', { value: width, configurable: true });
      Object.defineProperty(el, 'clientHeight', { value: height, configurable: true });
    };
    const { container, rerender } = view(<PanView contentWidth={800} contentHeight={600} />);
    const el = container.firstElementChild as HTMLElement;
    size(el, 400, 300);
    rerender(<PanView contentWidth={800} contentHeight={600} />);
    expect([el.scrollLeft, el.scrollTop]).toEqual([200, 150]);
    rerender(<PanView contentWidth={800} contentHeight={600} scale={2} />);
    expect([el.scrollLeft, el.scrollTop]).toEqual([600, 450]);
    size(el, 600, 300);
    act(() => observed.at(-1)!([], {} as ResizeObserver));
    expect([el.scrollLeft, el.scrollTop]).toEqual([500, 450]);
  });
});

// --- Sprite -----------------------------------------------------------------------

describe('Sprite', () => {
  it('turns to a new row on the frame it is on before the screen is drawn, with no flash of the first frame', () => {
    // React drew the new row's first frame, and the frame the sprite was on
    // came back only in an effect after the screen had been drawn: a walk
    // flickered at every turn made from a game's tick.
    const pending = new Map<number, FrameRequestCallback>();
    let handle = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      pending.set(++handle, cb);
      return handle;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => pending.delete(id));
    const frame = (time: number) => {
      const due = [...pending.values()];
      pending.clear();
      act(() => due.forEach((cb) => cb(time)));
    };
    let beforePaint = '';
    function Probe() {
      React.useLayoutEffect(() => {
        const sprite = document.querySelector<HTMLElement>('[data-probe-sprite]');
        if (sprite) beforePaint = sprite.style.backgroundPosition;
      });
      return null;
    }
    const draw = (row: number) => (
      <>
        <Sprite src="/hero.png" columns={4} row={row} fps={10} className="hero" style={{}} />
        <Probe />
      </>
    );
    const { container, rerender } = view(draw(0));
    container.querySelector('.hero')!.setAttribute('data-probe-sprite', '');
    frame(200);
    // The third frame of the first row (jsdom writes `-0px` as `0px`).
    expect((container.querySelector('.hero') as HTMLElement).style.backgroundPosition).toBe('-64px 0px');
    rerender(draw(1));
    expect(beforePaint).toBe('-64px -32px');
  });
});

// --- AnimatedNumber, AnimatedBox, Typewriter -----------------------------------------

describe('AnimatedNumber', () => {
  it('shows the value at once for a duration that is no time at all, rather than counting forever', () => {
    // A negative duration never made progress: the count stayed on its
    // first number and asked for a frame forever.
    const pending = new Map<number, FrameRequestCallback>();
    let handle = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      pending.set(++handle, cb);
      return handle;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => pending.delete(id));
    const { container } = view(<AnimatedNumber value={1500} duration={-200} />);
    for (let i = 0; i < 5 && pending.size > 0; i++) {
      const due = [...pending.values()];
      pending.clear();
      act(() => due.forEach((cb) => cb(performance.now())));
    }
    expect(container.querySelector('[aria-hidden="true"]')!.textContent).toBe('1,500');
    expect(pending.size).toBe(0);
  });
});

describe('AnimatedBox with trigger="state"', () => {
  it('starts hidden, without fading out on the first paint, and animates when made active', () => {
    // Its state was put on in an effect, after the first paint, with the
    // transition already set: content meant to start hidden showed and then
    // faded out on every page load.
    let atLayout = { opacity: '', transition: '' };
    function Probe() {
      React.useLayoutEffect(() => {
        const box = document.querySelector<HTMLElement>('.box');
        if (box) atLayout = { opacity: box.style.opacity, transition: box.style.transition };
      });
      return null;
    }
    const draw = (isActive: boolean) => (
      <>
        <AnimatedBox animation="fadeUp" trigger="state" isActive={isActive} className="box">
          <p>Hi</p>
        </AnimatedBox>
        <Probe />
      </>
    );
    const { container, rerender } = view(draw(false));
    const box = container.querySelector<HTMLElement>('.box')!;
    expect(atLayout).toEqual({ opacity: '0', transition: 'none' });
    expect(box.style.transition).toBe('none');
    rerender(draw(true));
    expect(box.style.opacity).toBe('1');
    expect(box.style.transition).toMatch(/^opacity 500ms/);
  });
});

describe('Typewriter', () => {
  it('calls onComplete once all its texts have been typed, not after each', () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    view(<Typewriter text={['ab', 'cd']} loop={false} speed={10} deleteSpeed={10} pauseDuration={20} onComplete={onComplete} />);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('calls it at the end of each cycle when it loops', () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    view(<Typewriter text={['ab', 'cd']} loop speed={10} deleteSpeed={10} pauseDuration={20} onComplete={onComplete} />);
    // One cycle: four characters typed and four deleted, two pauses.
    act(() => {
      vi.advanceTimersByTime(10 * 4 + 10 * 4 + 20 * 2 + 10 * 2);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
