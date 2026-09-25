/**
 * CodeEditor's highlight layer.
 *
 * The highlighted HTML sits under a transparent textarea, so anything the
 * highlighter emits that the user did not type shifts every character after it
 * out of alignment with the caret they are actually moving.
 */

import type React from 'react';
import { act } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, type } from './dom';
import { CodeEditor } from '../src/editors/CodeEditor';

beforeEach(() => {
  document.body.innerHTML = '';
});

type Language = React.ComponentProps<typeof CodeEditor>['language'];

/** The text the highlight layer actually displays. */
function highlighted(code: string, language: Language = 'javascript'): string {
  const { container } = mount(<CodeEditor value={code} language={language} />);
  const layer = container.querySelector<HTMLElement>('[data-softn-code-highlight]');
  return (layer?.textContent ?? '').replace(/\n$/, '');
}

describe('highlighting code that contains a comment', () => {
  it('does not display the colours it emitted', () => {
    // Patterns were applied one after another over HTML that already contained
    // injected `<span style="color: …">`, so the string pattern matched a
    // colour literal from an earlier pass. The text `"color: #a1a1aa">` became
    // visible in the layer under the textarea, and everything after the first
    // comment sat offset from what the user typed.
    const out = highlighted('// total\nlet x = 1');

    expect(out).not.toMatch(/color:/);
    expect(out).not.toMatch(/#[0-9a-f]{6}/i);
  });

  it('shows exactly the code it was given', () => {
    const code = '// total\nlet x = 1';
    expect(highlighted(code).replace(/\s+/g, ' ').trim()).toBe(code.replace(/\s+/g, ' ').trim());
  });

  it('does the same for a block comment', () => {
    const out = highlighted('/* note */\nconst y = "s"');
    expect(out).not.toMatch(/color:/);
  });

  it('does the same for a string containing a slash', () => {
    const out = highlighted('const p = "a//b"');
    expect(out).not.toMatch(/color:/);
    expect(out).toContain('a//b');
  });

  it('still applies colour spans', () => {
    const { container } = mount(<CodeEditor value={'const x = 1'} language="javascript" />);
    expect(container.querySelectorAll('span[style*="color"]').length).toBeGreaterThan(0);
  });

  it('leaves plain text alone', () => {
    expect(highlighted('just words', 'plain').trim()).toBe('just words');
  });
});

// --- The overlay, the keyboard and the props ------------------------------------

function parts(container: HTMLElement) {
  const layer = container.querySelector<HTMLElement>('[data-softn-code-highlight]')!;
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
  const gutter = container.querySelector<HTMLElement>('[data-softn-code-gutter]');
  return { layer, textarea, gutter };
}

function key(el: Element, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
}

/** Every inline style that decides where a glyph is drawn. */
const METRICS = [
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'word-spacing',
  'text-transform', 'text-indent', 'tab-size', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-left-width', 'box-sizing', 'white-space', 'overflow-wrap', 'word-break', 'direction',
];

describe('the highlight layer under the textarea', () => {
  const sources: Array<[Language, string]> = [
    ['javascript', 'const re = /"[/]\\//g;\nconst t = `a ${ `b` } c`;\n\tindented()\n'],
    ['typescript', 'interface A { x: string }\n@dec class B {}\n'],
    ['python', 'label = f"{count!r}"\n"""doc\nstring"""\n@app.route\n'],
    ['json', '{ "a": [1, 2, {"b": null}] }'],
    ['html', '<!DOCTYPE html>\n<p class="x">a &amp; b</p><style>p{color:red}</style>'],
    ['css', '@media (x) { a:hover { color: #fff !important } }'],
    ['sql', "SELECT 'it''s' -- c\n"],
    ['markdown', '# H\n```js\nconst a = 1\n```\n- **b** `c`'],
    ['plain', 'just <b>text</b> & more'],
  ];

  it.each(sources)('draws exactly the text the textarea holds (%s)', (language, source) => {
    const { container } = mount(<CodeEditor value={source} language={language} onChange={() => {}} />);
    const { layer, textarea } = parts(container);
    expect(textarea.value).toBe(source);
    // The trailing newline gives a final empty line its height, as the textarea does.
    expect(layer.textContent).toBe(`${source}\n`);
  });

  it('lays both layers out with the same text metrics, and neither wraps', () => {
    const { container } = mount(<CodeEditor defaultValue={'a\tb'} tabSize={4} />);
    const { layer, textarea } = parts(container);
    for (const property of METRICS) {
      expect(textarea.style.getPropertyValue(property), property).toBe(layer.style.getPropertyValue(property));
    }
    expect(layer.style.whiteSpace).toBe('pre');
    expect(textarea.getAttribute('wrap')).toBe('off');
    expect(layer.style.getPropertyValue('tab-size')).toBe('4');
    // The textarea is sized by the layer it covers, not by rows of its own.
    expect(textarea.style.position).toBe('absolute');
    expect(textarea.style.height).toBe('100%');
  });

  it('hides the textarea glyphs with colour only, so the native placeholder still shows', () => {
    // -webkit-text-fill-color is inherited by ::placeholder, which would make
    // "Enter code..." invisible in Chromium and Safari.
    const { container } = mount(<CodeEditor defaultValue="" placeholder="Type here" />);
    const { textarea } = parts(container);
    expect(textarea.style.color).toBe('transparent');
    expect(textarea.style.getPropertyValue('-webkit-text-fill-color')).toBe('');
    expect(textarea.placeholder).toBe('Type here');
  });

  it('renders markup in the source as text, never as elements', () => {
    const source = 'const s = "<img src=x onerror=alert(1)>"; // <script>alert(2)</script>';
    const { container } = mount(<CodeEditor value={source} language="javascript" />);
    const { layer } = parts(container);
    expect(layer.querySelector('img, script')).toBeNull();
    expect(layer.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('colours through theme variables with a fallback, and is hidden from assistive technology', () => {
    const { container } = mount(<CodeEditor value={'const x = 1'} language="javascript" />);
    const { layer } = parts(container);
    const keyword = layer.querySelector<HTMLElement>('.softn-code-keyword');
    expect(keyword?.textContent).toBe('const');
    expect(keyword?.style.color).toMatch(/^var\(--color-code-keyword, #[0-9a-f]{6}\)$/i);
    expect(layer.getAttribute('aria-hidden')).toBe('true');
  });

  it('numbers every line in a gutter that is hidden from assistive technology', () => {
    const { container, rerender } = mount(<CodeEditor value={'a\nb\nc'} onChange={() => {}} />);
    const { gutter } = parts(container);
    expect(gutter?.textContent).toBe('1\n2\n3');
    expect(gutter?.getAttribute('aria-hidden')).toBe('true');
    rerender(<CodeEditor value={'a\nb\nc'} onChange={() => {}} lineNumbers={false} />);
    expect(parts(container).gutter).toBeNull();
  });

  it('shows very large text uncoloured rather than scanning it on every keystroke', () => {
    const source = 'const x = 1;\n'.repeat(20_000);
    const { container } = mount(<CodeEditor value={source} language="javascript" />);
    const { layer } = parts(container);
    expect(layer.querySelector('span')).toBeNull();
    expect(layer.textContent).toBe(`${source}\n`);
  });
});

describe('CodeEditor keyboard', () => {
  it('indents with Tab, by the tab size, and puts the caret after the indent', () => {
    const onChange = vi.fn();
    const { container } = mount(<CodeEditor defaultValue={'ab'} tabSize={4} onChange={onChange} />);
    const { textarea } = parts(container);
    textarea.setSelectionRange(1, 1);
    const event = key(textarea, { key: 'Tab' });
    expect(event.defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith('a    b');
    expect(textarea.value).toBe('a    b');
    expect(textarea.selectionStart).toBe(5);
    expect(textarea.selectionEnd).toBe(5);
  });

  it('indents and outdents every selected line', () => {
    const { container } = mount(<CodeEditor defaultValue={'one\ntwo\nthree'} />);
    const { textarea } = parts(container);
    textarea.setSelectionRange(1, 6); // from "one" into "two"
    key(textarea, { key: 'Tab' });
    expect(textarea.value).toBe('  one\n  two\nthree');
    textarea.setSelectionRange(0, textarea.value.length);
    key(textarea, { key: 'Tab', shiftKey: true });
    expect(textarea.value).toBe('one\ntwo\nthree');
  });

  it('lets Tab move focus on after Escape, so the editor is not a keyboard trap', () => {
    const { container } = mount(<CodeEditor defaultValue={'x'} />);
    const { textarea } = parts(container);
    key(textarea, { key: 'Escape' });
    const released = key(textarea, { key: 'Tab' });
    expect(released.defaultPrevented).toBe(false);
    expect(textarea.value).toBe('x');
    // Any other key hands Tab back to the editor.
    key(textarea, { key: 'Escape' });
    key(textarea, { key: 'ArrowLeft' });
    expect(key(textarea, { key: 'Tab' }).defaultPrevented).toBe(true);
  });

  it('names the field and describes how to leave it with the keyboard', () => {
    const { container } = mount(<CodeEditor defaultValue={'x'} ariaLabel="Query" />);
    const { textarea } = parts(container);
    expect(textarea.getAttribute('aria-label')).toBe('Query');
    const hint = document.getElementById(textarea.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toMatch(/Escape/);
  });

  it('does not take Tab when read-only or disabled', () => {
    const readOnly = mount(<CodeEditor defaultValue={'x'} readOnly />);
    expect(key(parts(readOnly.container).textarea, { key: 'Tab' }).defaultPrevented).toBe(false);
    const disabled = mount(<CodeEditor defaultValue={'x'} disabled />);
    expect(key(parts(disabled.container).textarea, { key: 'Tab' }).defaultPrevented).toBe(false);
  });

  it('keeps the indentation of the current line on Enter', () => {
    const { container } = mount(<CodeEditor defaultValue={'    if (x) {'} />);
    const { textarea } = parts(container);
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    key(textarea, { key: 'Enter' });
    expect(textarea.value).toBe('    if (x) {\n    ');
    expect(textarea.selectionStart).toBe(textarea.value.length);
  });
});

describe('CodeEditor value', () => {
  it('is held by a parent that handles onChange, which can refuse an edit', () => {
    const onChange = vi.fn();
    const { container } = mount(<CodeEditor value={'fixed'} onChange={onChange} />);
    const { textarea } = parts(container);
    type(textarea as unknown as HTMLInputElement, 'fixed!');
    expect(onChange).toHaveBeenCalledWith('fixed!');
    expect(textarea.value).toBe('fixed');
  });

  it('follows a new value from the parent', () => {
    const { container, rerender } = mount(<CodeEditor value={'one'} onChange={() => {}} />);
    rerender(<CodeEditor value={'two'} onChange={() => {}} />);
    expect(parts(container).textarea.value).toBe('two');
  });

  it('can still be typed in when given a value but no handler, and follows a new value', () => {
    const { container, rerender } = mount(<CodeEditor value={'seed'} />);
    const { textarea } = parts(container);
    type(textarea as unknown as HTMLInputElement, 'seed typed');
    expect(textarea.value).toBe('seed typed');
    rerender(<CodeEditor value={'reset'} />);
    expect(textarea.value).toBe('reset');
  });

  it('shows a null or numeric value bound from app state as text instead of throwing', () => {
    const { container, rerender } = mount(<CodeEditor value={null as unknown as string} onChange={() => {}} language="json" />);
    expect(parts(container).textarea.value).toBe('');
    rerender(<CodeEditor value={42 as unknown as string} onChange={() => {}} language="json" />);
    expect(parts(container).textarea.value).toBe('42');
    expect(parts(container).layer.textContent).toBe('42\n');
  });

  it('passes className and style to the root', () => {
    const { container } = mount(<CodeEditor className="mine" style={{ margin: '3px' }} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toBe('mine');
    expect(root.style.margin).toBe('3px');
  });
});
