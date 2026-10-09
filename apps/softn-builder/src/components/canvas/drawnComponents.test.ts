// @vitest-environment jsdom
/**
 * The components the canvas draws as themselves are safe to have sitting on
 * it, each one, and that is held here and not taken on trust.
 *
 * A component is on the list (componentRegistry.ts, DRAWN_FOR_REAL) because,
 * mounted with what a page can write for it, it is a picture and nothing
 * more. Every one is mounted here in the canvas's own wrapper, with what a
 * new one starts with and with a null for everything, and has to: draw
 * without throwing or warning; listen to nothing on the document or the
 * window; start no timer, frame or observer; write no style that reaches
 * past its own classes; and be given no handler. One that stops doing so
 * (a Select that learns to listen for a click outside while it is shut)
 * fails here, and leaves the list.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { builtinComponents } from '@softn/components';
import type { CanvasElement, ComponentMeta } from '../../types/builder';
import { componentRegistry, getComponentMeta } from '../../utils/componentRegistry';
import { drawnProps, neverPassed, WORDS } from '../../utils/drawnProps';
import { drawnThemeFor, systemSide } from '../../utils/drawnTheme';
import { starterProps } from '../../utils/starterProps';
import { DrawnComponent, DrawnThemeProvider } from './DrawnComponent';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const drawn = componentRegistry.filter((meta) => meta.drawn).map((meta) => meta.name).sort();

type ManifestMember = { name: string; type: { kind: string } };
type ManifestComponent = { name: string; props: { members: ManifestMember[] } | null };

/** The manifest, found by walking up: `import.meta.url` is an http URL under jsdom. */
function findManifest(): string {
  const rel = 'packages/@softn/components/component-manifest.json';
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, rel);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`Could not find ${rel} from ${process.cwd()}`);
}

const manifest: { components: ManifestComponent[] } = JSON.parse(readFileSync(findManifest(), 'utf8'));
const members = (type: string): ManifestMember[] => manifest.components.find((component) => component.name === type)?.props?.members ?? [];

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  // React's own listeners are on the document before anything is watched,
  // and so are those jsdom's selector engine adds the first time it is used.
  act(() => root.render(React.createElement('div')));
  document.querySelector('div');
  // A QR code is painted on a canvas, which this DOM has no painter for and says so at length.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

function element(type: string, props: Record<string, unknown> = {}, expressionProps: string[] = [], more: Partial<CanvasElement> = {}): CanvasElement {
  return { id: `el-${type}`, componentType: type, props, children: [], parentId: 'root', ...(expressionProps.length ? { expressionProps } : {}), ...more } as CanvasElement;
}

/** A new one, as the palette makes it. */
function started(type: string): CanvasElement {
  const starter = starterProps(type);
  return element(type, starter.props, starter.expressionProps);
}

/** One whose every property is bound to state that has not arrived. */
function allNull(type: string): CanvasElement {
  const names = members(type).map((member) => member.name).filter((name) => !/^(children|style|className|ref|key)$/.test(name));
  return element(type, Object.fromEntries(names.map((name) => [name, 'null'])), names);
}

const FALLBACK = React.createElement('div', { 'data-stand-in': '' }, 'stand-in');

function draw(el: CanvasElement, theme: { tokens: 'light' | 'dark'; page: 'light' | 'dark' } = { tokens: 'light', page: 'light' }): void {
  const meta = getComponentMeta(el.componentType) as ComponentMeta;
  act(() =>
    root.render(
      // The canvas's own surroundings: the theme, and the page each is drawn in.
      React.createElement(DrawnThemeProvider, { theme }, React.createElement(DrawnComponent, { element: el, meta, fallback: FALLBACK }))
    )
  );
}

/** Everything a component could do that reaches past its own box, recorded while `run` mounts it. */
function watched(run: () => void): string[] {
  const seen: string[] = [];
  const note = (what: string) => () => {
    seen.push(what);
    return 0;
  };
  const spies = [
    vi.spyOn(document, 'addEventListener').mockImplementation((type) => void seen.push(`document.addEventListener(${type})`)),
    vi.spyOn(window, 'addEventListener').mockImplementation((type) => void seen.push(`window.addEventListener(${type})`)),
    vi.spyOn(globalThis, 'setInterval').mockImplementation(note('setInterval') as unknown as typeof setInterval),
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(note('setTimeout') as unknown as typeof setTimeout),
    vi.spyOn(console, 'error').mockImplementation((...args) => void seen.push(`console.error: ${String(args[0]).slice(0, 160)}`)),
    vi.spyOn(console, 'warn').mockImplementation((...args) => void seen.push(`console.warn: ${String(args[0]).slice(0, 160)}`)),
  ];
  const globals = globalThis as unknown as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const name of ['requestAnimationFrame', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver']) {
    kept[name] = globals[name];
    globals[name] =
      name === 'requestAnimationFrame'
        ? note('requestAnimationFrame')
        : class {
            constructor() {
              seen.push(`new ${name}`);
            }
            observe(): void {}
            disconnect(): void {}
            unobserve(): void {}
          };
  }
  try {
    run();
  } finally {
    for (const spy of spies) spy.mockRestore();
    for (const [name, value] of Object.entries(kept)) globals[name] = value;
  }
  return seen;
}

describe('the watch kept on a component while it is mounted', () => {
  // The tests below pass when nothing is seen, so the watch has to be shown
  // to see: these four are left off the list for exactly what it reports.
  it.each([
    ['Toast', 'setInterval'],
    ['AnimatedNumber', 'requestAnimationFrame'],
    ['Marquee', 'new ResizeObserver'],
    ['Typewriter', 'setTimeout'],
  ])('sees what <%s> starts: %s', (type, started) => {
    const starter = starterProps(type);
    const meta = getComponentMeta(type) as ComponentMeta;
    const reached = watched(() =>
      act(() => root.render(React.createElement(DrawnComponent, { element: element(type, starter.props, starter.expressionProps), meta, fallback: FALLBACK })))
    );
    expect(reached).toContain(started);
  });

  it('sees a listener put on the document or the window', () => {
    function Listens(): React.ReactElement {
      React.useEffect(() => {
        document.addEventListener('mousedown', () => {});
        window.addEventListener('resize', () => {});
      }, []);
      return React.createElement('span');
    }
    expect(watched(() => act(() => root.render(React.createElement(Listens))))).toEqual([
      'document.addEventListener(mousedown)',
      'window.addEventListener(resize)',
    ]);
  });
});

describe('what a drawn component is given', () => {
  const meta = (type: string) => getComponentMeta(type) as ComponentMeta;

  it('is what the page wrote as the value itself', () => {
    expect(drawnProps(element('Badge', { variant: 'success', pill: true, children: 'New' }), meta('Badge'))).toEqual({
      variant: 'success',
      pill: true,
      children: 'New',
    });
  });

  it('is the value written in braces when it is one all the way down, read and not run', () => {
    const steps = element('Steps', { items: '["Cart", "Pay", { label: "Done", description: `Thanks` }]', current: '-1' }, ['items', 'current']);
    expect(drawnProps(steps, meta('Steps'))).toEqual({
      items: ['Cart', 'Pay', { label: 'Done', description: 'Thanks' }],
      current: -1,
    });
    expect(drawnProps(element('Progress', { value: '60', striped: 'false' }, ['value', 'striped']), meta('Progress'))).toEqual({ value: 60, striped: false });
  });

  it('is never the text of an expression where a list, a number or a switch is expected: what a new one starts with stands in', () => {
    // `items={tasks}` handed over as the string "tasks" is a list of five
    // letters to a component that maps over it, and `value={done / total}`
    // a width of NaN.
    for (const text of ['tasks', '[first, "B"]', 'steps.map((step) => step.name)', '[...base]', '{ ...base }', '[{ label }]', '[{ [key]: 1 }]', '`${count} left`']) {
      expect(drawnProps(element('Steps', { items: text }, ['items']), meta('Steps')), text).toEqual({ items: ['Details', 'Review', 'Done'] });
    }
    expect(drawnProps(element('Progress', { value: 'done / total' }, ['value']), meta('Progress'))).toEqual({ value: 50 });
    // Where the registry starts it with nothing, the component is left to its own default.
    expect(drawnProps(element('Checkbox', { checked: 'task.done', label: 'Done' }, ['checked']), meta('Checkbox'))).toEqual({ label: 'Done' });
    expect(drawnProps(element('Avatar', { src: 'user.photo' }, ['src']), meta('Avatar'))).toEqual({});
  });

  it('shows an expression as written where words are shown, and runs nothing', () => {
    let ran = false;
    (globalThis as Record<string, unknown>).drawnProbe = () => {
      ran = true;
      return 'ran';
    };
    const stat = element('Stat', { label: 'task.title', value: 'drawnProbe()', children: 'Open: {count}' }, ['label', 'value']);
    expect(drawnProps(stat, meta('Stat'))).toEqual({ label: '{task.title}', value: '{drawnProbe()}', children: 'Open: {count}' });
    draw(stat);
    expect(host.textContent).toContain('{task.title}');
    expect(host.textContent).toContain('{drawnProbe()}');
    expect(ran).toBe(false);
    delete (globalThis as Record<string, unknown>).drawnProbe;
  });

  it('shows what a field is bound to as its value', () => {
    expect(drawnProps(element('Input', { placeholder: 'Name' }, [], { bindings: { bind: 'form.name' } }), meta('Input'))).toEqual({
      placeholder: 'Name',
      value: '{form.name}',
    });
    // A switch has no words to show a binding in.
    expect(drawnProps(element('Switch', { label: 'On' }, [], { bindings: { bind: 'on' } }), meta('Switch'))).toEqual({ label: 'On' });
  });

  it('is nothing the browser would fetch as the component draws, at any depth of what it is given', () => {
    // A running app asks its permissions before a picture is fetched. The
    // canvas has none to ask, and shows a page as soon as its file is
    // opened: a bundle from somebody else would have called home from the
    // Design view, by being looked at.
    const avatar = element('Avatar', { src: 'https://example.com/ada.png', fallbackSrc: '//example.com/b.png', name: 'Ada' });
    expect(drawnProps(avatar, meta('Avatar'))).toEqual({ name: 'Ada' });
    draw(avatar);
    expect(host.querySelectorAll('img, image, use, [src], [srcset]')).toHaveLength(0);

    const items = '[{ label: "Home", href: "/" }, { label: "Bad", href: "javascript:alert(1)" }, { label: "Pic", icon: { src: "https://example.com/i.png" } }]';
    expect(drawnProps(element('Breadcrumb', { items }, ['items']), meta('Breadcrumb'))).toEqual({
      // A link is written, where the runtime would write it, and followed by nobody here.
      items: [{ label: 'Home', href: '/' }, { label: 'Bad' }, { label: 'Pic', icon: {} }],
    });
  });

  it('is styled as the page wrote, less any declaration that would load something', () => {
    const written = element('Badge', {
      style: 'margin-top: 4px; background: url(https://example.com/b.png); background-image: \\75rl(x.png); --gap: 2px; font-family: "A;B", serif',
      class: 'big',
      className: 'loud',
      children: 'New',
    });
    expect(drawnProps(written, meta('Badge'))).toEqual({
      style: { marginTop: '4px', '--gap': '2px', fontFamily: '"A;B", serif' },
      className: 'big loud',
      children: 'New',
    });
    // Written as a record, it is read as one and held to the same.
    const record = element('Badge', { style: '{ color: "red", backgroundImage: "url(x.png)", width: 12, flex: [1] }' }, ['style']);
    expect(drawnProps(record, meta('Badge'))).toEqual({ style: { color: 'red', width: 12 } });
    // A style that is worked out is not one the canvas has.
    expect(drawnProps(element('Badge', { style: 'styles.badge' }, ['style']), meta('Badge'))).toEqual({});
    // And it is drawn, where the text of a style handed to React throws.
    draw(written);
    expect(host.querySelector('[data-stand-in]')).toBeNull();
    expect(host.querySelector('.big.loud')).not.toBeNull();
  });

  it('takes the markup of a custom icon without what the markup would fetch', () => {
    const icon = element('Icon', { svg: '<svg viewBox="0 0 8 8"><use href="https://example.com/sprite.svg#a"/><image href="https://example.com/p.png"/><circle r="4"/></svg>' });
    const given = drawnProps(icon, meta('Icon'));
    expect(String(given.svg)).toContain('<circle');
    // The sanitiser keeps what was withheld under a name that fetches nothing.
    expect(String(given.svg)).not.toMatch(/\s(xlink:)?href=|<image/);
    expect(String(given.svg)).toContain('data-softn-withheld-href');
  });

  it('carries no id into the editor\'s own document, where a label of the editor\'s could find it', () => {
    expect(drawnProps(element('Input', { id: 'name', placeholder: 'Your name', autoFocus: true }), meta('Input'))).toEqual({ placeholder: 'Your name' });
  });
});

describe('an expression shown as written', () => {
  // A component that does sums with what it is given (a change as a
  // percentage, a count against its maximum) makes NaN of words. A prop is
  // on the list of those that show words only if the component shows them.
  const shown = Object.entries(WORDS).flatMap(([type, names]) => names.map((name) => [type, name] as const));

  it.each(shown)('<%s %s={task.title}> is drawn with those words, and nothing a sum made of them', (type, name) => {
    const starter = starterProps(type);
    const el = element(type, { ...starter.props, [name]: 'task.title' }, [...starter.expressionProps.filter((other) => other !== name), name]);
    expect(drawnProps(el, getComponentMeta(type)!)[name]).toBe('{task.title}');
    draw(el);
    expect(host.querySelector('[data-stand-in]')).toBeNull();
    const drawing = host.querySelector('[data-softn-drawn]')!;
    // What a person would read: the text but for a stylesheet's, what is in
    // a field or stands in for it, and what is said aloud for a picture.
    const words = [...drawing.querySelectorAll('*')]
      .filter((node) => node.tagName !== 'STYLE')
      .flatMap((node) => [...node.childNodes].filter((child) => child.nodeType === 3).map((child) => child.textContent ?? ''));
    const fields = [...drawing.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')].flatMap((field) => [field.value, field.placeholder]);
    const said = [...drawing.querySelectorAll('[aria-label]')].map((node) => node.getAttribute('aria-label') ?? '');
    const read = [...words, ...fields, ...said].join(' | ');
    expect(read).not.toMatch(/NaN|undefined|\[object Object\]|Infinity/);
    // Shown, but for the words a component keeps for another moment: what
    // it says when its list is empty, or once its button has been pressed.
    const keptForLater = ['Timeline emptyText', 'DescriptionList emptyText', 'CopyButton label', 'CopyButton copiedLabel'];
    if (!keptForLater.includes(`${type} ${name}`)) expect(read).toContain('{task.title}');
  });
});

describe('the wrapper a component is drawn in', () => {
  it('is inert and hidden from a screen reader, so nothing in it takes the focus or a key', () => {
    for (const type of ['Input', 'Select', 'Checkbox', 'Slider', 'Tabs', 'Pagination', 'CopyButton', 'Rating']) {
      draw(started(type));
      const wrapper = host.querySelector('[data-softn-drawn]')!;
      expect(wrapper.hasAttribute('inert'), type).toBe(true);
      expect(wrapper.getAttribute('aria-hidden'), type).toBe('true');
      // Whatever could take the focus is inside it.
      const focusable = [...host.querySelectorAll('a[href], button, input, select, textarea, [tabindex], [contenteditable]')];
      expect(focusable.filter((node) => !node.closest('[inert]')), type).toEqual([]);
    }
  });

  it('draws the stand-in when the component throws, and the canvas goes on', () => {
    const library = builtinComponents as unknown as Record<string, unknown>;
    const real = library.Badge;
    library.Badge = function Throws(): never {
      throw new Error('a component that cannot draw');
    };
    const quiet = [vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})];
    try {
      act(() =>
        root.render(
          React.createElement(
            'div',
            null,
            React.createElement(DrawnComponent, { element: started('Badge'), meta: getComponentMeta('Badge')!, fallback: FALLBACK }),
            React.createElement(DrawnComponent, { element: started('Kbd'), meta: getComponentMeta('Kbd')!, fallback: FALLBACK })
          )
        )
      );
    } finally {
      library.Badge = real;
      for (const spy of quiet) spy.mockRestore();
    }
    // The Badge is its stand-in; the Kbd beside it is drawn.
    expect(host.querySelectorAll('[data-stand-in]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-softn-drawn]')).toHaveLength(1);
    expect(host.querySelector('kbd')).not.toBeNull();
  });

  it('tries again when what the element is given changes', () => {
    const library = builtinComponents as unknown as Record<string, unknown>;
    const real = library.Badge as React.ComponentType<Record<string, unknown>>;
    library.Badge = function ThrowsForOne(props: Record<string, unknown>): React.ReactElement {
      if (props.variant === 'bad') throw new Error('one value it cannot draw');
      return React.createElement(real, props);
    };
    const quiet = [vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})];
    try {
      draw(element('Badge', { variant: 'bad', children: 'New' }));
      expect(host.querySelector('[data-stand-in]')).not.toBeNull();
      draw(element('Badge', { variant: 'success', children: 'New' }));
      expect(host.querySelector('[data-stand-in]')).toBeNull();
      expect(host.textContent).toContain('New');
    } finally {
      library.Badge = real;
      for (const spy of quiet) spy.mockRestore();
    }
  });

  it('carries the project theme by an attribute of its own, and the page colours by the page the component is in', () => {
    // The runtime writes its tokens on :root, which here is the editor.
    draw(started('Badge'), { tokens: 'dark', page: 'light' });
    const wrapper = host.querySelector('[data-softn-drawn]')!;
    expect(wrapper.getAttribute('data-softn-drawn')).toBe('dark');
    expect(wrapper.querySelector('.softn-app')!.classList.contains('softn-theme-light')).toBe(true);
    const tokens = host.querySelector('style[data-softn-drawn-tokens]')!.textContent!;
    expect(tokens).toMatch(/^\[data-softn-drawn="light"\]\{[^{}]+\}\n\[data-softn-drawn="dark"\]\{[^{}]+\}$/);
    expect(tokens).toContain('--color-primary-500:');
    expect(tokens).not.toContain(':root');
  });

  it('is in a page that is what an App of that side makes of its own container, read from one and not copied', () => {
    // An App around every component was a stylesheet for every component.
    // One of each side is kept out of sight for its stylesheet, and the
    // page a component is drawn in takes its classes and its colours.
    draw(started('Badge'), { tokens: 'light', page: 'dark' });
    const donors = [...host.querySelectorAll('[data-softn-drawn-pages] .softn-app')];
    expect(donors.map((node) => node.className.trim().split(/\s+/).filter((name) => name.startsWith('softn-theme-')))).toEqual([['softn-theme-light'], ['softn-theme-dark']]);
    const page = host.querySelector<HTMLElement>('[data-softn-drawn] > div')!;
    expect(page.className).toBe(donors[1].className);
    // The colour and the face the App sets on its container, as it wrote them.
    for (const name of ['color', 'font-family', 'line-height', 'letter-spacing']) {
      expect(page.style.getPropertyValue(name), name).toBe((donors[1] as HTMLElement).style.getPropertyValue(name));
      expect(page.style.getPropertyValue(name), name).not.toBe('');
    }
    // As high as what it holds, where the app's page is a screen high.
    expect(page.style.height).toBe('auto');
    // And one stylesheet of the App's for each side, however many components are drawn.
    expect(host.querySelectorAll('[data-softn-drawn] style')).toHaveLength(0);
    expect(host.querySelectorAll('[data-softn-drawn-pages] style')).toHaveLength(2);
  });
});

describe('the theme the canvas draws in', () => {
  it('is the project theme, with the page able to pin its own colours over it', () => {
    expect(drawnThemeFor('light', 'system', 'dark')).toEqual({ tokens: 'light', page: 'light' });
    expect(drawnThemeFor('dark', undefined, 'light')).toEqual({ tokens: 'dark', page: 'dark' });
    expect(drawnThemeFor('system', 'system', 'dark')).toEqual({ tokens: 'dark', page: 'dark' });
    // A dark project whose page says light is drawn light, as it runs.
    expect(drawnThemeFor('dark', 'light', 'dark')).toEqual({ tokens: 'dark', page: 'light' });
    expect(drawnThemeFor('light', 'dark', 'light')).toEqual({ tokens: 'light', page: 'dark' });
    // A theme of the author's own is neither, and follows the project.
    expect(drawnThemeFor('dark', 'brand', 'light')).toEqual({ tokens: 'dark', page: 'dark' });
  });

  it('reads "system" as the running app would: the choice a visitor made there, before the device', () => {
    window.localStorage.setItem('softn-theme-preference', 'dark');
    expect(systemSide()).toBe('dark');
    window.localStorage.setItem('softn-theme-preference', 'light');
    expect(systemSide()).toBe('light');
    window.localStorage.removeItem('softn-theme-preference');
    // No choice stored: the device, which here has no preference for dark.
    expect(systemSide()).toBe('light');
  });
});

describe('the list of components drawn as themselves', () => {
  it('names only components the library has', () => {
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.filter((type) => !(type in builtinComponents))).toEqual([]);
  });
});

describe.each(drawn)('<%s> drawn on the canvas', (type) => {
  it('draws with what a new one starts with, reaching for nothing outside itself', () => {
    const reached = watched(() => draw(started(type)));
    expect(reached).toEqual([]);
    expect(host.querySelector('[data-stand-in]'), 'its stand-in was drawn in its place').toBeNull();
    expect(host.querySelector('[data-softn-drawn]')).not.toBeNull();
  });

  it('draws with a null for everything it could be given', () => {
    const reached = watched(() => draw(allNull(type)));
    expect(reached).toEqual([]);
    expect(host.querySelector('[data-stand-in]')).toBeNull();
  });

  it('is given no handler, whatever the page has written for one', () => {
    const functions = members(type).filter((member) => member.type.kind === 'function').map((member) => member.name);
    expect(functions.filter((name) => !neverPassed(type, name)), 'a function the manifest declares that would be passed').toEqual([]);
    const meta = getComponentMeta(type)!;
    // Written as text, as an expression and as an event, none of it arrives.
    const el = element(
      type,
      Object.fromEntries(functions.map((name) => [name, 'save'])),
      functions.slice(0, Math.ceil(functions.length / 2)),
      { events: { click: 'save()', change: 'save' }, bindings: { bind: 'value' } }
    );
    const given = drawnProps(el, meta);
    expect(Object.entries(given).filter(([, value]) => typeof value === 'function')).toEqual([]);
    expect(Object.keys(given).filter((name) => functions.includes(name) || /^on[A-Z]/.test(name))).toEqual([]);
  });

  it('writes no style that reaches past its own classes, and no animation under a name the editor uses', () => {
    draw(started(type));
    const written = stylesWritten();
    // Every alternative of every selector has to begin at a class of the library's.
    expect(written.selectors.filter((selector) => !/^\s*\.softn-[\w-]+/.test(selector))).toEqual([]);
    // And at none the editor's own chrome wears (the product bar has a `softn-theme-toggle`).
    expect(written.selectors.filter((selector) => EDITOR_CLASSES.has(/^\s*\.([\w-]+)/.exec(selector)?.[1] ?? ''))).toEqual([]);
    // An animation is found by its name alone, anywhere in the document: the
    // library's all carry its prefix, and none is one the editor has.
    expect(written.animations.filter((name) => !name.startsWith('softn-') || EDITOR_KEYFRAMES.has(name))).toEqual([]);
  });
});

/** The selectors and the animation names of every stylesheet drawn under the host, but the tokens' own. */
function stylesWritten(): { selectors: string[]; animations: string[] } {
  const selectors: string[] = [];
  const animations: string[] = [];
  const walk = (rules: CSSRuleList | undefined): void => {
    for (const rule of Array.from(rules ?? [])) {
      const selector = (rule as CSSStyleRule).selectorText;
      if (typeof selector === 'string') selectors.push(...selector.split(',').map((part) => part.trim()));
      else if (rule.constructor.name.includes('Keyframes')) animations.push((rule as CSSKeyframesRule).name);
      else if ((rule as CSSMediaRule).cssRules) walk((rule as CSSMediaRule).cssRules);
    }
  };
  for (const style of host.querySelectorAll('style')) {
    if (!style.hasAttribute('data-softn-drawn-tokens')) walk(style.sheet?.cssRules);
  }
  return { selectors, animations };
}

describe('the look at what a drawn component writes into the document', () => {
  // The test above passes when nothing is found, so it is shown to find.
  it('sees the rules of the page a component is drawn in, and the animation a Spinner names', () => {
    draw(started('Spinner'));
    const written = stylesWritten();
    expect(written.selectors).toContain('.softn-theme-dark');
    expect(written.selectors.some((selector) => selector.startsWith('.softn-app'))).toBe(true);
    expect(written.animations.length).toBeGreaterThan(0);
  });

  it('knows the names of the editor\'s own animations and classes', () => {
    expect(EDITOR_KEYFRAMES.size).toBeGreaterThan(0);
    expect(EDITOR_CLASSES.has('softn-theme-toggle')).toBe(true);
    expect(EDITOR_CLASSES.has('bl-btn')).toBe(true);
  });
});

const EDITOR_STYLESHEETS = ['src/styles/builder.css', 'index.html', '../../packages/@softn/brand/src/bar.css', '../../packages/@softn/brand/src/tokens.css']
  .map((file) => resolve(process.cwd(), file))
  .filter((file) => existsSync(file))
  .map((file) => readFileSync(file, 'utf8'));

/** The classes the editor's own stylesheets are written against. */
const EDITOR_CLASSES = new Set(EDITOR_STYLESHEETS.flatMap((css) => [...css.matchAll(/\.(-?[A-Za-z_][\w-]*)(?=[^{}]*\{)/g)].map((match) => match[1])));

/** The animations the editor's own stylesheets name: one of the same name written later would replace it. */
const EDITOR_KEYFRAMES = new Set(
  ['src/styles/builder.css', 'index.html', '../../packages/@softn/brand/src/bar.css', '../../packages/@softn/brand/src/tokens.css']
    .map((file) => resolve(process.cwd(), file))
    .filter((file) => existsSync(file))
    .flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/@keyframes\s+([\w-]+)/g)].map((match) => match[1]))
);
