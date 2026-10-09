/**
 * No built-in component may throw for what a page has not given it yet.
 *
 * Two things an author does before anything else: writes the bare tag
 * (`<DataGrid />`, which is also what Builder writes for every component
 * dropped from its palette: a new element has no props), and binds a prop to
 * state that starts as `null` and is filled in when the data arrives. A default
 * parameter covers the first and not the second: `items = []` is still
 * `null` when `null` is passed. Either way the component threw in its render
 * and the page showed the renderer's red error box where an empty grid, an
 * empty form or an unset picker belonged.
 *
 * A sweep of all of them in Chromium found six that did (DataGrid and
 * SmartForm with nothing at all; ColorPicker, MarkdownEditor, PixelGrid and
 * SortableList with a `null`), one that drew a canvas sized NaN (TileMap) and
 * one that handed React a null input value (Select). Held to the manifest's
 * own list of what each one takes, another twenty turned up, most of them
 * the same line: `sizeStyles[size].padding`, which throws for a `null` and
 * equally for `<Button size="huge">`, a name that is not one of the
 * choices. This holds every component to all of it, so the next one is too.
 *
 * Each is mounted in a DOM, not only rendered to markup: an effect that
 * reads `value.length` throws just as a render does, and server rendering
 * runs no effects.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { mount, type } from './dom';
import { builtinComponents } from '../src/registry';
import { choice } from '../src/utils/choice';
import manifest from '../component-manifest.json';

interface Member {
  name: string;
  type: { kind: string; text?: string; options?: string[] };
}
interface Entry {
  name: string;
  props?: { members?: Member[] };
}

// The scanner library asks its canvas for a 2D context as it mounts, which
// jsdom does not have; QRReader's own handling of its props is what is held
// here, over a stand-in for the library, as the capability tests do.
vi.mock('@yudiel/react-qr-scanner', () => ({
  prepareZXingModule: () => {},
  Scanner: (): React.ReactElement => React.createElement('video'),
}));

const entries = new Map((manifest as unknown as { components: Entry[] }).components.map((entry) => [entry.name, entry]));
const components = builtinComponents as unknown as Record<string, React.ComponentType<Record<string, unknown>>>;

/** Everything the component declares, but what React itself takes. */
function declared(tag: string): Member[] {
  const members = entries.get(tag)?.props?.members ?? [];
  return members.filter((member) => !/^(children|style|className|ref|key)$/.test(member.name));
}

/** The props that name one of a fixed set: a size, a variant. */
function choices(tag: string): string[] {
  return declared(tag)
    .filter((member) => member.type.kind === 'enum' || (member.type.kind === 'other' && /^('[^']*'|"[^"]*"|\d+)(\s*\|\s*('[^']*'|"[^"]*"|\d+))+$/.test(member.type.text ?? '')))
    .map((member) => member.name);
}

/** What the renderer wraps each component in: the error is kept, not rethrown. */
class Caught extends React.Component<{ children: React.ReactNode; report: (error: Error) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(error: Error): void {
    this.props.report(error);
  }
  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** What the component threw, mounted with these props and taken down again; null when it drew. */
function thrown(tag: string, props: Record<string, unknown>): string | null {
  const Component = components[tag];
  let message: string | null = null;
  const quiet = [vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})];
  try {
    const mounted = mount(
      <Caught report={(error) => (message = String(error?.message ?? error))}>
        <Component {...props} />
      </Caught>
    );
    mounted.unmount();
  } catch (error) {
    message = String((error as Error)?.message ?? error);
  } finally {
    for (const spy of quiet) spy.mockRestore();
  }
  return message;
}

function markup(tag: string, props: Record<string, unknown>): string {
  const Component = components[tag];
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    return renderToStaticMarkup(<Component {...props} />);
  } finally {
    quiet.mockRestore();
  }
}

const tags = Object.keys(builtinComponents).sort();

describe('a component with nothing given to it', () => {
  it.each(tags)('<%s /> draws', (tag) => {
    expect(thrown(tag, {})).toBeNull();
  });
});

describe('a component whose state has not arrived', () => {
  it.each(tags)('<%s> draws with null for anything it is bound to', (tag) => {
    const names = declared(tag).map((member) => member.name);
    const failed: string[] = [];
    // All of them at once, as a page whose state is all null gives them...
    const all = thrown(tag, Object.fromEntries(names.map((name) => [name, null])));
    if (all !== null) failed.push(`everything null: ${all}`);
    // ...and one at a time, so a guard on the first does not hide the second.
    for (const name of names) {
      const one = thrown(tag, { [name]: null });
      if (one !== null) failed.push(`${name}={null}: ${one}`);
    }
    expect(failed).toEqual([]);
  });
});

describe('a component given a name that is not one of its choices', () => {
  it.each(tags)('<%s> draws as its default', (tag) => {
    const failed: string[] = [];
    // A mistyped variant, a size from another library, a name every object has.
    for (const name of choices(tag)) {
      for (const wrong of ['no-such-choice', 'constructor', 7]) {
        const message = thrown(tag, { [name]: wrong });
        if (message !== null) failed.push(`${name}=${JSON.stringify(wrong)}: ${message}`);
      }
    }
    expect(failed).toEqual([]);
  });
});

describe('what they draw in that state', () => {
  it('a TileMap with no map has a canvas of no size, not one sized NaN', () => {
    expect(markup('TileMap', {})).not.toContain('NaN');
  });

  it('a Select bound to null is an empty one: its field is given an empty value, not a null', () => {
    // React takes a null value as "not controlled" and leaves the attribute
    // off (and warns, but only once a page, so the warning cannot be the
    // test). An empty value is written.
    expect(markup('Select', { name: 'choice', value: null, options: ['a', 'b'] })).toContain('name="choice" value=""');
  });

  it('a DataGrid given rows and no columns shows the rows, a column for each field', () => {
    const drawn = markup('DataGrid', { data: [{ id: 1, name: 'Ann', team: 'Blue' }] });
    for (const text of ['name', 'team', 'Ann', 'Blue']) expect(drawn).toContain(text);
  });

  it('a SmartForm with no fields is an empty form, and stray commas are not fields', () => {
    expect(markup('SmartForm', {})).toContain('<form');
    const drawn = markup('SmartForm', { fields: 'name, , email:email,' });
    expect((drawn.match(/<input/g) ?? []).length).toBe(2);
  });

  it('a DataGrid column may be only the name of its field, and what is not a column is left out', () => {
    const drawn = markup('DataGrid', { data: [{ id: 7, name: 'Ann', team: 'Blue' }], columns: ['name', null, { header: 'no key' }, { key: 'team', header: 'Team' }] });
    expect(drawn).toContain('Ann');
    expect(drawn).toContain('Team');
    expect(drawn).not.toContain('no key');
    // `id` is a field of the row and was not asked for.
    expect((drawn.match(/role="columnheader"/g) ?? []).length).toBe(2);
  });

  it('a SmartForm field in a list may be its spec as text', () => {
    const drawn = markup('SmartForm', { fields: ['name', { name: 'age', type: 'number' }, null, { type: 'text' }] });
    expect((drawn.match(/<input/g) ?? []).length).toBe(2);
  });

  it('SmartStats reads columns="3", as an attribute is written, as three', () => {
    expect(markup('SmartStats', { stats: 'Users:10, Orders:4', columns: '3' })).toContain('repeat(3, 1fr)');
    expect(markup('SmartStats', { stats: 'Users:10, Orders:4', columns: { lg: 2 } })).toContain('repeat(2, 1fr)');
    expect(markup('SmartStats', { stats: 'Users:10, Orders:4', columns: null })).toContain('repeat(4, 1fr)');
  });

  it('a TileMap given only its layers is the size they cover', () => {
    const layers = [[[0, 1, 2], [3, 4, 5]], [[0, 1, 2, 3]]];
    const drawn = markup('TileMap', { layers, tileSize: 16, scale: 2 });
    expect(drawn).toContain('width="64"');
    expect(drawn).toContain('height="32"');
    expect(drawn).toContain('width:128px');
    // What it is given still decides.
    expect(markup('TileMap', { layers, tileSize: 16, mapWidth: 10, mapHeight: 5 })).toContain('width="160"');
  });

  it('a ColorPicker bound to null shows its default colour, and clearing the hex field is not a choice', () => {
    const ColorPicker = components.ColorPicker;
    const changes: string[] = [];
    const picker = mount(<ColorPicker value={null} onChange={(color: string) => changes.push(color)} />);
    try {
      const trigger = picker.container.querySelector('button');
      expect(trigger?.getAttribute('aria-label')).toBe('Colour #6366F1');
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    } finally {
      picker.unmount();
    }
    const open = mount(<ColorPicker defaultValue="#112233" onChange={(color: string) => changes.push(color)} />);
    try {
      const { act } = React as unknown as { act: (run: () => void) => void };
      act(() => open.container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      const hex = open.container.querySelector<HTMLInputElement>('input[aria-label="Hex colour"]');
      expect(hex).not.toBeNull();
      type(hex, '');
      expect(changes).toEqual([]);
      type(hex, '#abc');
      expect(changes).toEqual(['#AABBCC']);
    } finally {
      open.unmount();
    }
  });

  it('a MarkdownEditor bound to null is an empty document, and a number is its digits', () => {
    expect(markup('MarkdownEditor', { value: null })).toContain('<textarea');
    expect(markup('MarkdownEditor', { value: 42 })).toContain('42');
  });

  it('a Scene3D in a browser with no WebGL says so, where it used to be the error box', () => {
    // jsdom gives no WebGL context, which is what such a browser does.
    const Scene3D = components.Scene3D;
    const scene = mount(<Scene3D objects={[{ id: 'a', type: 'box' }]} crosshair />);
    try {
      expect(scene.container.querySelector('[role="note"]')?.textContent).toContain('WebGL');
    } finally {
      scene.unmount();
    }
  });

  it('a chart keeps its own padding on the sides it is not given, and takes one number for all four', () => {
    const series = [{ name: 'a', data: [{ x: 1, y: 2 }, { x: 2, y: 4 }] }];
    for (const padding of [{ left: 80 }, 30, null]) {
      const drawn = markup('LineChart', { series, padding });
      expect(drawn, JSON.stringify(padding)).not.toContain('NaN');
      expect(drawn, JSON.stringify(padding)).toContain('<path');
    }
    // The value axis's labels sit eight to the left of the plot: its left
    // side is the one given, and the chart's own 50 without one.
    expect(markup('LineChart', { series, padding: { left: 80 } })).toContain('x="72"');
    expect(markup('LineChart', { series, padding: 30 })).toContain('x="22"');
    expect(markup('LineChart', { series, padding: null })).toContain('x="42"');
  });
});

/**
 * A page is not typed: a date is kept as a timestamp, an id is a number, a
 * list from a store has a hole where a record was deleted, and a spec string
 * is half typed. Each of these threw.
 */
describe('a value of another shape than the prop expects', () => {
  const rows = [null, { id: 1, name: 'Ann', title: 'Ann', status: 'done' }, undefined];

  it.each(['Table', 'DataGrid', 'SmartGrid', 'SmartList', 'SmartTimeline', 'SmartCards'])('<%s> draws the records of a list that has holes', (tag) => {
    const props: Record<string, unknown> = { data: rows, primary: 'name', title: 'name' };
    if (tag === 'Table') props.columns = [null, { key: 'name', header: 'Name' }];
    expect(thrown(tag, props)).toBeNull();
    expect(markup(tag, props)).toContain('Ann');
  });

  it.each(['SmartGrid', 'SmartList', 'SmartTimeline', 'SmartCards'])('<%s> given a list of plain text has no records to draw, and does not throw', (tag) => {
    expect(thrown(tag, { data: ['Ann', 'Ben'] })).toBeNull();
    expect(thrown(tag, { data: [7, true] })).toBeNull();
  });

  it('a DatePicker given a timestamp shows that day', () => {
    const day = new Date(2024, 2, 9, 15, 30).getTime();
    const picker = mount(React.createElement(components.DatePicker, { value: day }));
    try {
      const shown = picker.container.querySelector('input')?.value ?? picker.container.textContent ?? '';
      expect(shown).toMatch(/2024/);
      expect(shown).toMatch(/0?9/);
    } finally {
      picker.unmount();
    }
    for (const wrong of [true, {}, [], Number.NaN, 'not a date']) {
      expect(thrown('DatePicker', { value: wrong, min: wrong, max: wrong, defaultValue: wrong }), JSON.stringify(wrong)).toBeNull();
    }
  });

  it('a TextArea whose value goes back to null is emptied', () => {
    const TextArea = components.TextArea;
    const field = mount(<TextArea value="a draft" />);
    try {
      const textarea = field.container.querySelector('textarea');
      expect(textarea?.value).toBe('a draft');
      field.rerender(<TextArea value={null} />);
      expect(textarea?.value).toBe('');
    } finally {
      field.unmount();
    }
  });

  it('an Avatar whose presence is null or not one it knows has no presence dot, and a number is a name', () => {
    const dot = (props: Record<string, unknown>) => /<span[^>]*aria-hidden="true"><\/span>/.test(markup('Avatar', props));
    expect(dot({ name: 'Ann', status: 'online' })).toBe(true);
    for (const status of [null, 'none', 'asleep', 'constructor']) expect(dot({ name: 'Ann', status }), String(status)).toBe(false);
    expect(markup('Avatar', { name: 'Ann', status: null })).not.toContain('null');
    expect(markup('Avatar', { name: 7 })).toContain('>7<');
  });

  it('SmartStats draws a spec whose figure is not typed yet, and keeps icons in their places', () => {
    expect(markup('SmartStats', { stats: 'Users' })).toContain('Users');
    expect(thrown('SmartStats', { stats: 'Users:10,,Orders' })).toBeNull();
    // A figure that has not arrived is a dash, not the word "undefined".
    const waiting = markup('SmartStats', { stats: [null, { label: 'Users', value: undefined }] });
    expect(waiting).toContain('—');
    expect(waiting).not.toContain('undefined');
    expect(thrown('SmartStats', { stats: 7, icons: 7, trends: true })).toBeNull();
    // The third stat's icon is the third in the list, not the second: the
    // empty place between them is the second stat's, which has none.
    const cards = markup('SmartStats', { stats: 'A:1, B:2, C:3', icons: 'users,,cart' }).split('padding:1.25rem').slice(1);
    expect(cards.map((card) => card.includes('<svg'))).toEqual([true, false, true]);
  });

  it('SmartGrid leaves an empty name out of its columns, and SmartCards out of its badges', () => {
    const data = [{ id: 1, name: 'Ann', team: 'Blue' }];
    expect((markup('SmartGrid', { data, columns: 'name,,team' }).match(/<th /g) ?? []).length).toBe(2);
    expect(thrown('SmartGrid', { data, columns: 7 })).toBeNull();
    expect(thrown('SmartCards', { data, badges: 7, meta: true })).toBeNull();
  });

  it('a GaugeChart takes thresholds with a hole, or none that are a list', () => {
    expect(thrown('GaugeChart', { value: 60, thresholds: [null, { value: 50, color: 'red' }] })).toBeNull();
    expect(thrown('GaugeChart', { value: 60, thresholds: 7 })).toBeNull();
  });

  it('a name every object has is not one of a component’s sizes', () => {
    for (const tag of ['Badge', 'Kbd', 'Tag', 'Progress', 'Rating', 'Steps']) {
      expect(markup(tag, { size: 'constructor' }), tag).toBe(markup(tag, { size: 'no-such-size' }));
    }
  });
});

describe('choice', () => {
  const sizes = { sm: 1, md: 2, lg: 3 };

  it('is the named entry', () => {
    expect(choice(sizes, 'lg', 'md')).toBe(3);
  });

  it('is the default for a name that is not in the table, for null and for what is not a name', () => {
    for (const wrong of ['huge', '', null, undefined, 7, {}, ['lg']]) expect(choice(sizes, wrong, 'md')).toBe(2);
  });

  it('is the default for a name every object has', () => {
    for (const inherited of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) expect(choice(sizes, inherited, 'md')).toBe(2);
  });
});
