/**
 * Stat, Steps, Timeline and Kbd: the display components that say something
 * with a mark — an arrow, a tick, a coloured dot — and have to say the same
 * thing in words to someone who cannot see the mark.
 *
 * Also here: Skeleton as a tag. It was exported and described, and never
 * registered, so `<Skeleton>` in a page was an unknown component.
 */

import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse, renderDocument, ComponentRegistry } from '@softn/core';
import type { SoftNRenderContext, SoftNComponent } from '@softn/core';
import { mount, click } from './dom';
import { Stat } from '../src/display/Stat';
import { Kbd } from '../src/display/Kbd';
import { Steps } from '../src/navigation/Steps';
import { Timeline } from '../src/data/Timeline';
import { minimalComponents } from '../src/entries/minimal';

beforeEach(() => {
  document.body.innerHTML = '';
});

const text = (element: Element | null) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('Stat', () => {
  it('is a group named by its label, holding the figure', () => {
    const { container } = mount(<Stat label="Revenue" value="12,480" prefix="$" suffix="USD" />);
    const group = container.querySelector('[role=group]')!;
    expect(group.getAttribute('aria-label')).toBe('Revenue');
    expect(text(group)).toBe('Revenue$12,480USD');
  });

  it('shows a numeric change as a percentage and says its direction in words', () => {
    const { container } = mount(<Stat label="Signups" value={320} change={12.5} changeLabel="since last week" />);
    // The arrow is decoration; "Up" is what a screen reader hears.
    expect(text(container)).toBe('Signups320↑Up12.5%since last week');
    expect(container.querySelector('[aria-hidden=true]')!.textContent).toBe('↑');
  });

  it('drops the sign of a fall, which the direction already says', () => {
    const { container } = mount(<Stat label="Churn" value="2.1%" change={-0.4} />);
    expect(text(container)).toBe('Churn2.1%↓Down0.4%');
  });

  it('shows a change given as text as written, taking its direction from its sign', () => {
    const { container } = mount(<Stat label="Queue" value={18} change="+3 today" />);
    expect(text(container)).toBe('Queue18↑Up+3 today');
  });

  it('colours a move by whether it is good news, not by where the arrow points', () => {
    const colourOf = (element: React.ReactElement) => {
      const { container } = mount(element);
      const arrow = container.querySelector('[aria-hidden=true]')!;
      return (arrow.parentElement as HTMLElement).style.color;
    };
    const good = colourOf(<Stat label="Revenue" value={1} change={5} />);
    const bad = colourOf(<Stat label="Errors" value={1} change={5} positive="down" />);
    const alsoGood = colourOf(<Stat label="Errors" value={1} change={-5} positive="down" />);
    expect(good).toContain('success');
    expect(bad).toContain('error');
    expect(alsoGood).toBe(good);
  });

  it('shows no arrow for a change it cannot read a direction from', () => {
    const { container } = mount(<Stat label="Status" value="OK" change="steady" />);
    expect(text(container)).toBe('StatusOKsteady');
  });

  it('shows a dash for a figure that has not arrived', () => {
    const { container } = mount(<Stat label="Orders" />);
    expect(text(container)).toBe('Orders—');
  });

  it('shows zero as zero', () => {
    const { container } = mount(<Stat label="Open" value={0} change={0} />);
    expect(text(container)).toBe('Open0→No change0%');
  });
});

describe('Steps', () => {
  const ITEMS = ['Cart', 'Shipping', 'Payment'];
  const items = (container: HTMLElement) => [...container.querySelectorAll('li')];

  it('is an ordered list that marks the current step', () => {
    const { container } = mount(<Steps items={ITEMS} current={1} ariaLabel="Checkout" />);
    const list = container.querySelector('ol')!;
    expect(list.getAttribute('aria-label')).toBe('Checkout');
    expect(items(container).map((li) => li.getAttribute('aria-current'))).toEqual([null, 'step', null]);
  });

  it('says in words what the tick and the ring say', () => {
    const { container } = mount(<Steps items={ITEMS} current={1} />);
    expect(items(container).map((li) => text(li))).toEqual(['✓Completed: Cart', '2Current: Shipping', '3Payment']);
  });

  it('finds the current step by its key', () => {
    const steps = [
      { key: 'cart', label: 'Cart' },
      { key: 'pay', label: 'Payment', description: 'Card or invoice' },
    ];
    const { container } = mount(<Steps items={steps} current="pay" />);
    expect(items(container).map((li) => li.getAttribute('aria-current'))).toEqual([null, 'step']);
    expect(text(items(container)[1])).toContain('Card or invoice');
  });

  it('shows every step done when the position is past the last', () => {
    const { container } = mount(<Steps items={ITEMS} current={3} />);
    expect(items(container).every((li) => text(li).includes('Completed'))).toBe(true);
    expect(container.querySelector('[aria-current]')).toBeNull();
  });

  it('marks the current step as failed when told', () => {
    const { container } = mount(<Steps items={ITEMS} current={1} status="error" />);
    expect(text(items(container)[1])).toBe('!Error: Shipping');
  });

  it('is plain text without a handler, and buttons with one', () => {
    expect(mount(<Steps items={ITEMS} current={0} />).container.querySelector('button')).toBeNull();
    const seen: unknown[] = [];
    const { container } = mount(<Steps items={ITEMS} current={0} onChange={(step) => seen.push(step)} />);
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons).toHaveLength(3);
    expect(buttons[0].getAttribute('aria-current')).toBe('step');
    click(buttons[2]);
    expect(seen).toEqual([2]);
  });

  it('gives onChange a step\'s key when it has one, and skips a disabled step', () => {
    const steps = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B', disabled: true }, { key: 'c', label: 'C' }];
    const seen: unknown[] = [];
    const { container } = mount(<Steps items={steps} current="a" onChange={(step) => seen.push(step)} />);
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons[1].disabled).toBe(true);
    click(buttons[2]);
    expect(seen).toEqual(['c']);
  });

  it('survives items that are not a list, or hold something that is not a step', () => {
    expect(mount(<Steps items={undefined} />).container.querySelectorAll('li')).toHaveLength(0);
    const odd = ['One', null, 7, { label: 'Two' }] as unknown as string[];
    expect(mount(<Steps items={odd} />).container.querySelectorAll('li')).toHaveLength(2);
  });
});

describe('Timeline', () => {
  const EVENTS = [
    { key: 'a', title: 'Order placed', time: '09:14', description: 'Paid by card' },
    { key: 'b', title: 'Packed', time: '11:02', variant: 'success' as const },
    { key: 'c', title: 'Delayed', variant: 'warning' as const },
  ];

  it('is an ordered list of what happened, in the order given', () => {
    const { container } = mount(<Timeline items={EVENTS} ariaLabel="Order history" />);
    const list = container.querySelector('ol')!;
    expect(list.getAttribute('aria-label')).toBe('Order history');
    expect([...list.querySelectorAll('li')].map((li) => text(li))).toEqual([
      'Order placed09:14Paid by card',
      'Packed11:02',
      'Delayed',
    ]);
  });

  it('keeps its markers out of what is read aloud', () => {
    const { container } = mount(<Timeline items={EVENTS} />);
    expect(container.querySelectorAll('li > [aria-hidden=true]')).toHaveLength(3);
  });

  it('reverses for newest first without changing the list it was given', () => {
    const events = [...EVENTS];
    const { container } = mount(<Timeline items={events} reverse />);
    expect(text(container.querySelector('li'))).toBe('Delayed');
    expect(events).toEqual(EVENTS);
  });

  it('draws no line after the last entry, and none at all when asked', () => {
    const lines = (container: HTMLElement) =>
      [...container.querySelectorAll<HTMLElement>('li > [aria-hidden=true] > span')].filter((span) => span.style.width === '2px');
    expect(lines(mount(<Timeline items={EVENTS} />).container)).toHaveLength(2);
    expect(lines(mount(<Timeline items={EVENTS} showLine={false} />).container)).toHaveLength(0);
  });

  it('renders nothing for no entries, or the text it was given for that', () => {
    expect(mount(<Timeline items={[]} />).container.innerHTML).toBe('');
    expect(mount(<Timeline items={undefined} />).container.innerHTML).toBe('');
    expect(text(mount(<Timeline items={[]} emptyText="No activity yet" />).container)).toBe('No activity yet');
  });

  it('falls back to the default marker for a variant it does not know', () => {
    const odd = [{ title: 'Odd', variant: 'sparkly' }] as unknown as typeof EVENTS;
    expect(() => mount(<Timeline items={odd} />)).not.toThrow();
  });
});

describe('Kbd', () => {
  it('is one key', () => {
    expect(renderToStaticMarkup(<Kbd>Enter</Kbd>)).toMatch(/^<kbd[^>]*>Enter<\/kbd>$/);
    expect(renderToStaticMarkup(<Kbd keys="Esc" />)).toMatch(/^<kbd[^>]*>Esc<\/kbd>$/);
  });

  it('is a key inside a key for a combination, as HTML writes one', () => {
    const { container } = mount(<Kbd keys="Ctrl+Shift+K" />);
    const outer = container.querySelector('kbd')!;
    expect([...outer.querySelectorAll('kbd')].map((key) => key.textContent)).toEqual(['Ctrl', 'Shift', 'K']);
    expect(outer.textContent).toBe('Ctrl+Shift+K');
  });

  it('takes a list of keys and its own separator', () => {
    const { container } = mount(<Kbd keys={['⌘', 'K']} separator=" then " />);
    expect(container.textContent).toBe('⌘ then K');
  });

  it('keeps a plus that is itself the key', () => {
    const { container } = mount(<Kbd keys="Ctrl++" />);
    expect([...container.querySelectorAll('kbd kbd')].map((key) => key.textContent)).toEqual(['Ctrl', '+']);
  });
});

describe('the new tags in a page', () => {
  function html(source: string, state: Record<string, unknown> = {}): string {
    const doc = parse(source);
    expect(doc.diagnostics ?? []).toEqual([]);
    const registry = new ComponentRegistry();
    registry.registerAll(minimalComponents as unknown as Record<string, SoftNComponent>);
    const context: SoftNRenderContext = {
      state,
      setState: () => {},
      data: {},
      props: {},
      functions: {},
      asyncFunctions: {},
      computed: {},
    };
    return renderToStaticMarkup(<>{renderDocument(doc, context, registry)}</>);
  }

  it('are registered under the names a page writes', () => {
    for (const name of ['Stat', 'Kbd', 'Steps', 'Timeline', 'Rating', 'SegmentedControl', 'NumberInput', 'Skeleton']) {
      expect(Object.keys(minimalComponents), name).toContain(name);
    }
  });

  it('render from .ui source with state', () => {
    const out = html(
      [
        '<Stat label="Open tasks" value={open} change={delta} />',
        '<Steps items={["Draft", "Review", "Done"]} current={stage} />',
        '<Timeline items={events} />',
        '<Text>Press <Kbd keys="Ctrl+S" /> to save</Text>',
      ].join('\n'),
      { open: 7, delta: -2, stage: 1, events: [{ title: 'Created', time: 'Mon' }] }
    );
    expect(out).not.toContain('Unknown component');
    expect(out).toContain('Open tasks');
    expect(out).toContain('Current: </span>Review');
    expect(out).toContain('Created');
    expect(out).toContain('<kbd');
  });

  it('render a Skeleton while loading and its content after', () => {
    const page = '<Skeleton loading={busy} variant="text" lines={2}><Text>Loaded</Text></Skeleton>';
    const loading = html(page, { busy: true });
    expect(loading).not.toContain('Unknown component');
    expect(loading).not.toContain('Loaded');
    expect(html(page, { busy: false })).toContain('Loaded');
  });
});
