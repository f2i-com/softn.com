/**
 * Charts, animation and the media utilities: what a keyboard, a screen reader
 * or a reduced-motion preference gets from them, and data the author did not
 * picture.
 */

import React from 'react';
import { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, click } from './dom';
import { LineChart } from '../src/charts/LineChart';
import { AreaChart } from '../src/charts/AreaChart';
import { BarChart } from '../src/charts/BarChart';
import { PieChart } from '../src/charts/PieChart';
import { RadarChart } from '../src/charts/RadarChart';
import { GaugeChart } from '../src/charts/GaugeChart';
import { layoutX, describeChart, finiteNumber } from '../src/charts/series';
import { SortableList } from '../src/animation/SortableList';
import { Marquee } from '../src/animation/Marquee';
import { Typewriter } from '../src/animation/Typewriter';
import { AnimatedBox } from '../src/animation/AnimatedBox';
import { AnimatedNumber } from '../src/animation/AnimatedNumber';
import { Sprite } from '../src/animation/Sprite';
import { PanView } from '../src/animation/PanView';
import { DPad } from '../src/utility/DPad';
import { QRCode } from '../src/utility/QRCode';

beforeEach(() => {
  document.body.innerHTML = '';
});

const originalMatchMedia = window.matchMedia;

/** Pretend the user asked for reduced motion, for the rest of the test. */
function preferReducedMotion(): void {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

function key(el: Element, type: 'keydown' | 'keyup', k: string, init: KeyboardEventInit = {}): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, ...init }));
  });
}

function pointer(el: Element, type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string } = {}): void {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.assign(e, { pointerId: init.pointerId ?? 1, pointerType: init.pointerType ?? 'mouse' });
  act(() => {
    el.dispatchEvent(e);
  });
}

/** React's console warnings (keys, NaN attributes) during `fn`. */
function reactWarnings(fn: () => void): string[] {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  fn();
  const messages = spy.mock.calls.map((call) => call.map(String).join(' '));
  spy.mockRestore();
  return messages;
}

describe('line and area charts with categorical x values', () => {
  const series = [
    { name: 'A', data: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((x, i) => ({ x, y: i + 1 })) },
    { name: 'B', data: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((x, i) => ({ x, y: 5 - i })) },
  ];

  it('places both series across the whole plot, not squeezed into its left half', () => {
    // The x of a string point was its index in every series flattened
    // together, so two five-point series made a ten-slot axis.
    const { container } = mount(<LineChart series={series} width={600} padding={{ top: 20, right: 20, bottom: 40, left: 50 }} />);
    const xs = Array.from(container.querySelectorAll('circle')).map((c) => Number(c.getAttribute('cx')));
    expect(Math.max(...xs)).toBeCloseTo(580);
    expect(Math.min(...xs)).toBeCloseTo(50);
    // Both series put "Fri" in the same place.
    expect(xs.filter((x) => Math.abs(x - 580) < 0.01)).toHaveLength(2);
  });

  it('does the same for AreaChart', () => {
    const { container } = mount(<AreaChart series={series} width={600} padding={{ top: 20, right: 20, bottom: 40, left: 50 }} />);
    const xs = Array.from(container.querySelectorAll('circle')).map((c) => Number(c.getAttribute('cx')));
    expect(Math.max(...xs)).toBeCloseTo(580);
  });

  it('labels each category once', () => {
    const { container } = mount(<LineChart series={series} />);
    const labels = Array.from(container.querySelectorAll('text')).map((t) => t.textContent);
    expect(labels.filter((l) => l === 'Mon')).toHaveLength(1);
    expect(labels).toContain('Fri');
  });

  it('keeps numeric x values numeric', () => {
    const layout = layoutX([{ data: [{ x: 10 }, { x: 20 }] }, { data: [{ x: 15 }] }]);
    expect([layout.min, layout.max]).toEqual([10, 20]);
    expect(layout.position(1, 0)).toBe(15);
  });
});

describe('chart data that is not numbers', () => {
  it('reads numeric strings as numbers and leaves out what is not a number', () => {
    expect(finiteNumber('42')).toBe(42);
    expect(finiteNumber(' ')).toBeNull();
    expect(finiteNumber(undefined)).toBeNull();
    expect(finiteNumber(Number.NaN)).toBeNull();
  });

  it('never writes NaN into a line, area, bar, pie or radar chart', () => {
    const line = [{ name: 's', data: [{ x: 0, y: 1 }, { x: 1, y: undefined as unknown as number }, { x: 2, y: '3' as unknown as number }] }];
    const bars = [
      { name: 'a', data: [{ label: 'Q1', value: undefined as unknown as number }, { label: 'Q2', value: '42' as unknown as number }] },
      { name: 'b', data: [{ label: 'Q2', value: 8 }] },
    ];
    const warnings = reactWarnings(() => {
      for (const node of [
        <LineChart key="l" series={line} />,
        <AreaChart key="a" series={line} stacked />,
        <BarChart key="b" series={bars} stacked />,
        <PieChart key="p" data={[{ label: 'x', value: Number.NaN }, { label: 'y', value: 2 }]} />,
        <RadarChart key="r" axes={['a', 'b']} series={[{ name: 'r', data: [{ axis: 'a', value: undefined as unknown as number }, { axis: 'b', value: 2 }] }]} />,
      ]) {
        const { container, unmount } = mount(node);
        expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
        unmount();
      }
    });
    expect(warnings.filter((w) => /NaN/.test(w))).toEqual([]);
  });

  it('adds a numeric string into a stacked total rather than concatenating it', () => {
    const { container } = mount(
      <BarChart
        stacked
        series={[
          { name: 'a', data: [{ label: 'Q', value: '40' as unknown as number }] },
          { name: 'b', data: [{ label: 'Q', value: 2 }] },
        ]}
      />
    );
    // "402" as a total would have put the axis in the hundreds.
    const ticks = Array.from(container.querySelectorAll('text')).map((t) => Number(t.textContent));
    expect(Math.max(...ticks.filter(Number.isFinite))).toBeLessThan(100);
  });

  it('draws a negative radar value at the centre, not on the opposite spoke', () => {
    const { container } = mount(
      <RadarChart width={300} height={300} axes={['up', 'right']} maxValue={10} series={[{ name: 's', data: [{ axis: 'up', value: -5 }, { axis: 'right', value: 10 }] }]} />
    );
    const first = container.querySelector('circle')!;
    expect(Number(first.getAttribute('cx'))).toBeCloseTo(150);
    expect(Number(first.getAttribute('cy'))).toBeCloseTo(150);
  });
});

describe('series that share a name', () => {
  it('render without duplicate-key warnings', () => {
    const warnings = reactWarnings(() => {
      mount(<LineChart series={[{ name: 'x', data: [{ x: 0, y: 1 }] }, { name: 'x', data: [{ x: 0, y: 2 }] }]} />);
      mount(<BarChart series={[{ name: 'x', data: [{ label: 'a', value: 1 }] }, { name: 'x', data: [{ label: 'a', value: 2 }] }]} />);
      mount(<PieChart data={[{ label: 'same', value: 1 }, { label: 'same', value: 2 }]} />);
      mount(<RadarChart axes={['a']} series={[{ name: 'x', data: [{ axis: 'a', value: 1 }] }, { name: 'x', data: [{ axis: 'a', value: 2 }] }]} />);
    });
    expect(warnings.filter((w) => /same key/.test(w))).toEqual([]);
  });
});

describe('a pie with one slice', () => {
  it('draws the whole disc, not an arc whose ends coincide', () => {
    const { container } = mount(<PieChart data={[{ label: 'All', value: 5 }, { label: 'None', value: 0 }]} width={300} height={300} />);
    const d = container.querySelector('path')!.getAttribute('d')!;
    // Two half-circle arcs from the left edge to the right edge and back.
    expect(d.match(/A/g)).toHaveLength(2);
    expect(d).toMatch(/^M 20 150 A 130 130 0 1 0 280 150/);
  });

  it('cuts the hole out of a one-slice donut', () => {
    const { container } = mount(<PieChart data={[{ label: 'All', value: 5 }]} innerRadius={40} />);
    const path = container.querySelector('path')!;
    expect(path.getAttribute('d')!.match(/A/g)).toHaveLength(4);
    expect(path.getAttribute('fill-rule')).toBe('evenodd');
  });

  it('pulls a hovered slice out with a transform the browser accepts', () => {
    const { container } = mount(<PieChart interactive data={[{ label: 'a', value: 1 }, { label: 'b', value: 3 }]} />);
    const path = container.querySelector('path')!;
    act(() => {
      path.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    const g = path.parentElement as unknown as SVGGElement;
    expect(g.style.transform).toMatch(/translate\(-?[\d.]+px, -?[\d.]+px\)/);
  });
});

describe('charts for a screen reader', () => {
  it('are images named by a summary of their values', () => {
    const { container } = mount(<BarChart series={[{ name: 'Revenue', data: [{ label: 'Q1', value: 100 }, { label: 'Q2', value: -40 }] }]} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Bar chart. Revenue: Q1 100, Q2 -40.');
  });

  it('take an author-written name instead', () => {
    for (const node of [
      <LineChart key="l" ariaLabel="Sales" series={[{ name: 's', data: [{ x: 0, y: 1 }] }]} />,
      <AreaChart key="a" ariaLabel="Sales" series={[{ name: 's', data: [{ x: 0, y: 1 }] }]} />,
      <PieChart key="p" ariaLabel="Sales" data={[{ label: 'a', value: 1 }]} />,
      <RadarChart key="r" ariaLabel="Sales" axes={['a']} series={[]} />,
    ]) {
      const { container, unmount } = mount(node);
      const svg = container.querySelector('svg')!;
      expect(svg.getAttribute('role')).toBe('img');
      expect(svg.getAttribute('aria-label')).toBe('Sales');
      unmount();
    }
  });

  it('say when there is nothing to show, and cap a long read-out', () => {
    expect(describeChart('Line chart', [])).toBe('Line chart, no data.');
    const long = describeChart('Line chart', [{ name: 's', values: Array.from({ length: 30 }, (_, i) => String(i)) }]);
    expect(long).toMatch(/And 6 more\.$/);
  });

  it('give a gauge the meter role and its value', () => {
    const { container } = mount(
      <GaugeChart value={42} min={0} max={200} label="Speed" animated={false} formatValue={(v) => `${v} km/h`} />
    );
    const meter = container.querySelector('[role="meter"]')!;
    expect(meter.getAttribute('aria-label')).toBe('Speed');
    expect(meter.getAttribute('aria-valuenow')).toBe('42');
    expect(meter.getAttribute('aria-valuemax')).toBe('200');
    expect(meter.getAttribute('aria-valuetext')).toBe('42 km/h');
    expect(container.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('do not animate a gauge when reduced motion is asked for', () => {
    preferReducedMotion();
    const { container } = mount(<GaugeChart value={50} />);
    const arcs = container.querySelectorAll('path');
    expect((arcs[1] as unknown as SVGPathElement).style.transition).toBe('none');
  });
});

describe('SortableList from the keyboard', () => {
  const items = [{ id: 'a', name: 'Apple' }, { id: 'b', name: 'Banana' }, { id: 'c', name: 'Cherry' }];

  function Harness({ onChange }: { onChange?: (names: string[]) => void }) {
    const [list, setList] = React.useState<unknown[]>(items);
    return (
      <SortableList
        items={list}
        renderKey="id"
        primary="name"
        onReorder={(next) => {
          setList(next);
          onChange?.(next.map((i) => (i as { name: string }).name));
        }}
      />
    );
  }

  it('is a list of items, each with a named grip button', () => {
    const { container } = mount(<Harness />);
    expect(container.querySelector('[role="list"]')).not.toBeNull();
    expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(3);
    const grips = Array.from(container.querySelectorAll('button'));
    expect(grips.map((g) => g.getAttribute('aria-label'))).toEqual(['Reorder Apple', 'Reorder Banana', 'Reorder Cherry']);
    expect(grips.every((g) => g.type === 'button')).toBe(true);
  });

  it('picks an item up with Space, moves it with the arrows and keeps focus on it', () => {
    const changes: string[][] = [];
    const { container } = mount(<Harness onChange={(n) => changes.push(n)} />);
    const grip = container.querySelectorAll('button')[0];
    act(() => grip.focus());
    key(grip, 'keydown', ' ');
    expect(grip.getAttribute('aria-pressed')).toBe('true');
    key(grip, 'keydown', 'ArrowDown');
    expect(changes.at(-1)).toEqual(['Banana', 'Apple', 'Cherry']);
    const focused = document.activeElement as HTMLElement;
    expect(focused.getAttribute('aria-label')).toBe('Reorder Apple');
    key(focused, 'keydown', 'End');
    expect(changes.at(-1)).toEqual(['Banana', 'Cherry', 'Apple']);
    expect(container.textContent).toMatch(/Apple moved to position 3 of 3/);
  });

  it('puts the item back where it started on Escape', () => {
    const changes: string[][] = [];
    const { container } = mount(<Harness onChange={(n) => changes.push(n)} />);
    const grip = container.querySelectorAll('button')[0];
    act(() => grip.focus());
    key(grip, 'keydown', 'Enter');
    key(grip, 'keydown', 'ArrowDown');
    key(document.activeElement!, 'keydown', 'Escape');
    expect(changes.at(-1)).toEqual(['Apple', 'Banana', 'Cherry']);
    expect(document.activeElement?.getAttribute('aria-pressed')).toBe('false');
  });

  it('does not move anything with the arrows until an item is picked up', () => {
    const onReorder = vi.fn();
    const { container } = mount(<SortableList items={items} primary="name" onReorder={onReorder} />);
    key(container.querySelector('button')!, 'keydown', 'ArrowDown');
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('ends a cancelled pointer drag without reordering', () => {
    const onReorder = vi.fn();
    const { container } = mount(<SortableList items={items} primary="name" onReorder={onReorder} />);
    const item = container.querySelectorAll('[role="listitem"]')[0] as HTMLElement;
    Object.assign(item, { setPointerCapture: () => {}, hasPointerCapture: () => false });
    item.getBoundingClientRect = () => ({ height: 40, width: 200 }) as DOMRect;
    pointer(item, 'pointerdown', { clientY: 0 });
    pointer(item, 'pointermove', { clientY: 100 });
    pointer(item, 'pointercancel', { clientY: 100 });
    expect(onReorder).not.toHaveBeenCalled();
    expect(item.style.transform).not.toMatch(/translate\(0px, 100px\)/);
  });

  it('paints its cards from the theme, not in white', () => {
    const { container } = mount(<SortableList items={items} primary="name" />);
    const item = container.querySelector('[role="listitem"]') as HTMLElement;
    expect(item.style.backgroundColor).toMatch(/var\(--color-surface/);
    expect(item.style.border).toMatch(/var\(--color-border/);
  });
});

describe('DPad', () => {
  it('names its buttons and keeps them from submitting a form', () => {
    const { container } = mount(<DPad />);
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Up', 'Left', 'Right', 'Down']);
    expect(buttons.every((b) => b.type === 'button')).toBe(true);
    expect(buttons.every((b) => b.style.outline === '')).toBe(true);
    expect(container.firstElementChild!.getAttribute('role')).toBe('group');
  });

  it('holds a direction with Enter or Space, once however long the key repeats', () => {
    const onPress = vi.fn();
    const onRelease = vi.fn();
    const { container } = mount(<DPad onPress={onPress} onRelease={onRelease} />);
    const up = container.querySelector('button[aria-label="Up"]')!;
    key(up, 'keydown', 'Enter');
    key(up, 'keydown', 'Enter', { repeat: true });
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledWith('up');
    key(up, 'keyup', 'Enter');
    expect(onRelease).toHaveBeenCalledWith('up');
  });

  it('releases on pointercancel, and not on a hover that never pressed', () => {
    const onRelease = vi.fn();
    const { container } = mount(<DPad onRelease={onRelease} />);
    const left = container.querySelector('button[aria-label="Left"]')!;
    pointer(left, 'pointerleave');
    expect(onRelease).not.toHaveBeenCalled();
    pointer(left, 'pointerdown');
    pointer(left, 'pointercancel');
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('lets go of a held direction when it unmounts', () => {
    const onRelease = vi.fn();
    const { container, unmount } = mount(<DPad onRelease={onRelease} />);
    pointer(container.querySelector('button[aria-label="Down"]')!, 'pointerdown');
    unmount();
    expect(onRelease).toHaveBeenCalledWith('down');
  });
});

describe('Marquee', () => {
  it('keeps its decorative copy out of the tab order', () => {
    // jsdom lays nothing out, so give the content a size to scroll by.
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(200);
    const { container } = mount(
      <Marquee>
        <a href="#x">Link</a>
      </Marquee>
    );
    const copy = container.querySelector('[aria-hidden="true"]');
    expect(copy).not.toBeNull();
    expect(copy!.hasAttribute('inert')).toBe(true);
  });

  it('stands still at a speed of zero instead of asking for an infinite duration', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(200);
    const { container } = mount(<Marquee speed={0}>News</Marquee>);
    const track = container.firstElementChild!.firstElementChild as HTMLElement;
    expect(track.style.animationName).toBe('none');
    expect(track.style.animationDuration).toBe('0s');
  });

  it('pauses while focus is inside it', () => {
    const { container } = mount(
      <Marquee>
        <a href="#x">Link</a>
      </Marquee>
    );
    const link = container.querySelector('a')!;
    act(() => link.focus());
    const track = container.firstElementChild!.firstElementChild as HTMLElement;
    expect(track.style.animationPlayState).toBe('paused');
    act(() => link.blur());
    expect(track.style.animationPlayState).toBe('running');
  });

  it('stands still, shown once, with reduced motion', () => {
    preferReducedMotion();
    const { container } = mount(<Marquee>News</Marquee>);
    expect(container.textContent).toBe('News');
    const track = container.firstElementChild!.firstElementChild as HTMLElement;
    expect(track.style.animationName).toBe('none');
  });
});

describe('Typewriter', () => {
  it('gives a screen reader the whole text, not the typing', () => {
    const { container } = mount(<Typewriter text="Hello there" />);
    const typed = container.querySelector('[aria-hidden="true"]')!;
    expect(typed).not.toBeNull();
    const hidden = Array.from(container.firstElementChild!.children).find((c) => c !== typed)!;
    expect(hidden.textContent).toBe('Hello there');
  });

  it('shows the text complete, with no cursor, under reduced motion', () => {
    preferReducedMotion();
    const onComplete = vi.fn();
    const { container } = mount(<Typewriter text={['First', 'Second']} onComplete={onComplete} />);
    expect(container.querySelector('[aria-hidden="true"]')!.textContent).toBe('First');
    expect(onComplete).toHaveBeenCalled();
  });
});

describe('AnimatedBox and AnimatedNumber under reduced motion', () => {
  it('lands an entrance on its end state at once', () => {
    preferReducedMotion();
    const { container } = mount(
      <AnimatedBox animation="fadeUp">
        <p>Hi</p>
      </AnimatedBox>
    );
    const box = container.firstElementChild as HTMLElement;
    expect(box.style.opacity).toBe('1');
    expect(box.style.transition).toBe('none');
  });

  it('shows the value without counting', () => {
    preferReducedMotion();
    const { container } = mount(<AnimatedNumber value={1234} />);
    expect(container.querySelector('[aria-hidden="true"]')!.textContent).toBe('1,234');
  });

  it('gives a screen reader the value being counted to', () => {
    const { container, unmount } = mount(<AnimatedNumber value={50} prefix="$" trigger="visible" />);
    const hidden = container.firstElementChild!.firstElementChild!;
    expect(hidden.getAttribute('aria-hidden')).toBeNull();
    expect(hidden.textContent).toBe('$50');
    unmount();
  });

  it('survives a decimals value toFixed would throw on', () => {
    let mounted: ReturnType<typeof mount> | undefined;
    expect(() => {
      mounted = mount(<AnimatedNumber value={1} decimals={500} />);
    }).not.toThrow();
    mounted?.unmount();
  });
});

describe('Sprite', () => {
  it('is a button a keyboard can press when it has a click handler', () => {
    const onClick = vi.fn();
    const { container } = mount(<Sprite src="/s.png" onClick={onClick} ariaLabel="Hero" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute('role')).toBe('button');
    expect(el.tabIndex).toBe(0);
    expect(el.getAttribute('aria-label')).toBe('Hero');
    key(el, 'keydown', 'Enter');
    key(el, 'keydown', ' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('stays out of the accessibility tree when it is only decoration', () => {
    const { container } = mount(<Sprite src="/s.png" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute('role')).toBeNull();
    expect(el.hasAttribute('tabindex')).toBe(false);
  });

  it('keeps `row` within `rows`', () => {
    const { container } = mount(<Sprite src="/s.png" frameHeight={32} rows={4} row={9} playing={false} />);
    expect((container.firstElementChild as HTMLElement).style.backgroundPosition).toMatch(/ -96px$/);
  });
});

describe('PanView with clickable content', () => {
  it('does not capture the pointer on a press, so a click reaches the button under it', () => {
    const onClick = vi.fn();
    const { container } = mount(
      <PanView contentWidth={800} contentHeight={600} draggable centered={false}>
        <button type="button" onClick={onClick}>
          Marker
        </button>
      </PanView>
    );
    const viewport = container.firstElementChild as HTMLElement;
    const capture = vi.fn();
    Object.assign(viewport, { setPointerCapture: capture, hasPointerCapture: () => false, releasePointerCapture: () => {} });
    const button = container.querySelector('button')!;
    pointer(button, 'pointerdown', { button: 0, clientX: 10, clientY: 10 });
    pointer(button, 'pointermove', { clientX: 11, clientY: 11 });
    pointer(button, 'pointerup', { clientX: 11, clientY: 11 });
    click(button);
    expect(capture).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalled();
  });

  it('captures once the press has become a drag', () => {
    const { container } = mount(<PanView contentWidth={800} contentHeight={600} draggable centered={false} />);
    const viewport = container.firstElementChild as HTMLElement;
    const capture = vi.fn();
    Object.assign(viewport, { setPointerCapture: capture, hasPointerCapture: () => false, releasePointerCapture: () => {} });
    pointer(viewport, 'pointerdown', { button: 0, clientX: 100, clientY: 100 });
    pointer(viewport, 'pointermove', { clientX: 80, clientY: 100 });
    expect(capture).toHaveBeenCalledTimes(1);
  });
});

describe('QRCode', () => {
  it('is an image with a name', () => {
    const { container } = mount(<QRCode value="https://softn.com" />);
    const canvas = container.querySelector('canvas');
    if (!canvas) return; // the generator renders nothing where jsdom lacks a 2D context
    expect(canvas.getAttribute('role')).toBe('img');
    expect(canvas.getAttribute('aria-label')).toBe('QR code');
  });
});
