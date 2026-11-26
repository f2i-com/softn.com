/**
 * The smart components and the charts, round three: what they still drew
 * wrong, sent wrong or did too often.
 */

import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, click, byText, type Mounted } from './dom';
import { SmartGrid } from '../src/smart/SmartGrid';
import { SmartForm } from '../src/smart/SmartForm';
import { LineChart } from '../src/charts/LineChart';
import { AreaChart } from '../src/charts/AreaChart';
import { BarChart } from '../src/charts/BarChart';
import { GaugeChart } from '../src/charts/GaugeChart';
import { SmartStats } from '../src/smart/SmartStats';
import { SmartList } from '../src/smart/SmartList';
import { SmartCards } from '../src/smart/SmartCards';
import { SmartView } from '../src/smart/SmartView';
import { SmartTimeline } from '../src/smart/SmartTimeline';

const mounted: Mounted[] = [];
function draw(element: React.ReactElement): Mounted {
  const view = mount(element);
  mounted.push(view);
  return view;
}
afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** A day as SmartGrid draws it in its cells. */
const gridDay = (year: number, month: number, day: number) =>
  new Date(year, month, day).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

const cells = (container: HTMLElement, column = 0) =>
  Array.from(container.querySelectorAll('tbody tr')).map((row) => row.querySelectorAll('td')[column]?.textContent);

const editButtons = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLButtonElement>('button[title="Edit"]'));

function submitForm(container: HTMLElement) {
  act(() => {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

function choose(select: HTMLSelectElement | null, value: string) {
  if (!select) throw new Error('choose: no select');
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('SmartGrid date columns', () => {
  it('shows a blank or unreadable cell of a date column as written, not "Invalid Date"', () => {
    const data = [{ id: 1, due: '2024-03-15' }, { id: 2, due: '' }, { id: 3, due: 'soon' }];
    const { container } = draw(<SmartGrid data={data} columns="due" />);
    expect(cells(container)).toEqual([gridDay(2024, 2, 15), '', 'soon']);
  });

  it('shows a day that is not on the calendar as written, not as the day it rolls over to', () => {
    const data = [{ id: 1, due: '2024-02-30' }, { id: 2, due: '2024-13-45' }];
    const { container } = draw(<SmartGrid data={data} columns="due" />);
    expect(cells(container)).toEqual(['2024-02-30', '2024-13-45']);
  });

  it('types a column from its first cell that is not blank', () => {
    // A form saves an empty date field as "": the column was typed text from
    // it, and every date under it was drawn as raw ISO text.
    const data = [{ id: 1, due: '' }, { id: 2, due: '2024-03-15' }];
    const { container } = draw(<SmartGrid data={data} columns="due" />);
    expect(cells(container)).toEqual(['', gridDay(2024, 2, 15)]);
  });

  it('opens the editor on the day a date cell holds, and saves it unchanged when it is not touched', () => {
    const onEdit = vi.fn();
    const data = [
      { id: 1, name: 'A', due: '2024-03-15T09:30:00' },
      { id: 2, name: 'B', due: new Date(2024, 6, 4, 18, 0) },
    ];
    const { container } = draw(<SmartGrid data={data} columns="name, due" editable onEdit={onEdit} />);
    click(editButtons(container)[0]);
    expect(container.querySelector<HTMLInputElement>('[role="dialog"] input[type="date"]')!.value).toBe('2024-03-15');
    click(byText(container, /^Save$/));
    expect(onEdit).toHaveBeenCalledWith(data[0], expect.objectContaining({ due: '2024-03-15T09:30:00' }));

    click(editButtons(container)[1]);
    expect(container.querySelector<HTMLInputElement>('[role="dialog"] input[type="date"]')!.value).toBe('2024-07-04');
  });
});

describe('SmartGrid pages', () => {
  it('does not draw an empty page for a moment when the data shrinks under the page it is on', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `Row ${i + 1}` }));
    const view = draw(<SmartGrid data={rows} columns="name" pageable pageSize={10} />);
    click(view.container.querySelector('button[aria-label="Next page"]'));
    expect(cells(view.container)).toEqual(['Row 11', 'Row 12']);

    const observer = new MutationObserver(() => {});
    observer.observe(view.container, { childList: true, subtree: true, characterData: true });
    view.rerender(<SmartGrid data={rows.slice(0, 10)} columns="name" pageable pageSize={10} />);
    const added = observer.takeRecords().flatMap((record) => Array.from(record.addedNodes));
    observer.disconnect();
    expect(added.some((node) => (node.textContent ?? '').includes('No data available'))).toBe(false);
    expect(cells(view.container)).toHaveLength(10);
  });
});

describe('SmartGrid under the pointer', () => {
  it('does not draw every cell again when the pointer moves onto a row', () => {
    let drawnCells = 0;
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: i, name: `Row ${i}` }));
    const renderColumn = {
      name: (value: unknown) => {
        drawnCells += 1;
        return String(value);
      },
    };
    const { container } = draw(<SmartGrid data={rows} columns="name" renderColumn={renderColumn} />);
    expect(drawnCells).toBe(40);
    drawnCells = 0;
    const row = container.querySelectorAll('tbody tr')[3];
    act(() => {
      row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    act(() => {
      row.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(drawnCells).toBe(0);
  });
});

describe('SmartForm moving to another record', () => {
  const fields = [{ name: 'name', type: 'text' as const, required: true }];

  it('leaves the last record’s validation errors behind', () => {
    const view = draw(<SmartForm fields={fields} data={{ name: '' }} onSubmit={vi.fn()} />);
    submitForm(view.container);
    expect(view.container.textContent).toContain('This field is required');

    view.rerender(<SmartForm fields={fields} data={{ name: 'Bea' }} onSubmit={vi.fn()} />);
    const input = view.container.querySelector<HTMLInputElement>('input[name="name"]')!;
    expect(input.value).toBe('Bea');
    expect(view.container.textContent).not.toContain('This field is required');
    expect(input.getAttribute('aria-invalid')).toBe('false');
  });

  it('leaves the last record’s failed save behind', async () => {
    const failing = vi.fn(async () => {
      throw new Error('Server said no');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = draw(<SmartForm fields={fields} data={{ name: 'Ann' }} onSubmit={failing} />);
    await act(async () => {
      view.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(view.container.textContent).toContain('Server said no');
    view.rerender(<SmartForm fields={fields} data={{ name: 'Bea' }} onSubmit={failing} />);
    expect(view.container.textContent).not.toContain('Server said no');
  });
});

describe('SmartForm select fields', () => {
  it('offers numbers as choices and saves the number chosen', () => {
    const onSubmit = vi.fn();
    const fieldList = [{ name: 'rating', type: 'select', options: [1, 2, 3] }];
    const { container } = draw(<SmartForm fields={fieldList as never} onSubmit={onSubmit} />);
    const select = container.querySelector('select');
    expect(Array.from(select!.options).map((option) => option.textContent)).toEqual(['Select...', '1', '2', '3']);
    choose(select, '2');
    submitForm(container);
    expect(onSubmit).toHaveBeenCalledWith({ rating: 2 });
  });

  it('leaves out a hole in its options rather than failing to draw', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fieldList = [{ name: 'status', type: 'select', options: ['open', null, { value: 'done', label: 'Done' }] }];
    const { container } = draw(<SmartForm fields={fieldList as never} />);
    const select = container.querySelector('select');
    expect(Array.from(select!.options).map((option) => option.value)).toEqual(['', 'open', 'done']);
  });

  it('takes its options written as text', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fieldList = [{ name: 'size', type: 'select', options: 'small, large' }];
    const { container } = draw(<SmartForm fields={fieldList as never} />);
    const select = container.querySelector('select');
    expect(Array.from(select!.options).map((option) => option.value)).toEqual(['', 'small', 'large']);
  });
});

describe('SmartForm date fields', () => {
  it('show the day of a date that has a time, and send it on unchanged', () => {
    const onSubmit = vi.fn();
    const { container } = draw(<SmartForm fields="due:date" data={{ due: '2024-03-15T09:30:00' }} onSubmit={onSubmit} />);
    expect(container.querySelector<HTMLInputElement>('input[type="date"]')!.value).toBe('2024-03-15');
    submitForm(container);
    expect(onSubmit).toHaveBeenCalledWith({ due: '2024-03-15T09:30:00' });
  });
});

/** The value axis's labels of a chart, in the order drawn. */
const valueLabels = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('svg text[text-anchor="end"]')).map((text) => text.textContent);

/** Give a chart's SVG the box a browser would, so a pointer can be placed on it. */
function placeSvg(container: HTMLElement, width = 600, height = 300): SVGSVGElement {
  const svg = container.querySelector('svg')!;
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  return svg;
}

function pointerAt(svg: SVGSVGElement, clientX: number) {
  act(() => {
    svg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX, clientY: 100 }));
  });
}

const tooltipOf = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>('div')).find((div) => div.style.position === 'absolute' && div.style.pointerEvents === 'none');

describe('a chart of losses only', () => {
  const losses = [{ name: 'pnl', data: [{ x: 0, y: -100 }, { x: 1, y: -50 }] }];

  it.each([
    ['LineChart', () => <LineChart series={losses} />],
    ['AreaChart', () => <AreaChart series={losses} />],
  ])('%s tops its value axis at zero, not at 1', (_name, render) => {
    const { container } = draw(render());
    expect(valueLabels(container)).toEqual(['0', '-24', '-48', '-72', '-96', '-120']);
  });

  it('BarChart ends its value axis at zero, not at 1', () => {
    const { container } = draw(<BarChart series={[{ name: 'pnl', data: [{ label: 'Q1', value: -100 }, { label: 'Q2', value: -50 }] }]} />);
    expect(valueLabels(container)).toEqual(['-120', '-96', '-72', '-48', '-24', '0']);
  });
});

describe('BarChart layouts', () => {
  const rects = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('svg rect')).map((rect) => ({
      x: Number(rect.getAttribute('x')),
      y: Number(rect.getAttribute('y')),
      w: Number(rect.getAttribute('width')),
      h: Number(rect.getAttribute('height')),
    }));

  it('draws series that are not grouped over one another, each in its own category', () => {
    const series = [
      { name: 'a', data: [{ label: 'Q1', value: 10 }, { label: 'Q2', value: 5 }] },
      { name: 'b', data: [{ label: 'Q1', value: 6 }, { label: 'Q2', value: 8 }] },
    ];
    const { container } = draw(<BarChart series={series} grouped={false} width={600} height={300} />);
    const [q1a, q1b, q2a, q2b] = rects(container);
    expect(q1b.x).toBeCloseTo(q1a.x);
    expect(q2b.x).toBeCloseTo(q2a.x);
    // Q1's bars end before Q2's category starts, and Q2's inside the plot.
    expect(q1b.x + q1b.w).toBeLessThanOrEqual(50 + 265);
    expect(q2b.x + q2b.w).toBeLessThanOrEqual(580);
  });

  it('stacks a loss down from zero and a gain up from it, both inside the plot', () => {
    const series = [
      { name: 'gain', data: [{ label: 'Q1', value: 10 }] },
      { name: 'loss', data: [{ label: 'Q1', value: -5 }] },
    ];
    const { container } = draw(<BarChart series={series} stacked width={600} height={300} />);
    const [gain, loss] = rects(container);
    // The plot runs from y = 20 to y = 250.
    for (const bar of [gain, loss]) {
      expect(bar.y).toBeGreaterThanOrEqual(20 - 1e-6);
      expect(bar.y + bar.h).toBeLessThanOrEqual(250 + 1e-6);
    }
    // They meet at zero, and do not overlap.
    expect(loss.y).toBeCloseTo(gain.y + gain.h);
    expect(gain.h / loss.h).toBeCloseTo(2);
  });
});

describe('the value under the pointer of a line or area chart', () => {
  const series = [
    { name: 'A', data: [{ x: 1, y: 10 }, { x: 2, y: 20 }, { x: 3, y: 30 }] },
    { name: 'B', data: [{ x: 2, y: 200 }, { x: 3, y: 300 }, { x: 4, y: 400 }] },
  ];

  it.each([
    ['LineChart', () => <LineChart series={series} interactive width={600} height={300} />],
    ['AreaChart', () => <AreaChart series={series} interactive width={600} height={300} />],
  ])('%s gives each series’ value at that x, not at the same place in its list', (_name, render) => {
    const { container } = draw(render());
    // x = 2 sits a third of the way along the plot: 50 + 530 / 3.
    pointerAt(placeSvg(container), 227);
    const tooltip = tooltipOf(container)!;
    expect(tooltip.textContent).toContain('A:20');
    expect(tooltip.textContent).toContain('B:200');
    expect(tooltip.textContent).not.toContain('300');
  });

  it('leaves out a series with no point at that x', () => {
    const { container } = draw(<LineChart series={series} interactive width={600} height={300} />);
    pointerAt(placeSvg(container), 50);
    const tooltip = tooltipOf(container)!;
    expect(tooltip.textContent).toContain('A:10');
    expect(tooltip.textContent).not.toContain('B:');
  });
});

describe('a stacked AreaChart', () => {
  const dotsOf = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('circle')).map((c) => ({ x: Number(c.getAttribute('cx')), y: Number(c.getAttribute('cy')) }));

  it('stacks each series on the others at the same x, not at the same place in its list', () => {
    const series = [
      { name: 'A', data: [{ x: 'Jan', y: 10 }, { x: 'Feb', y: 20 }, { x: 'Mar', y: 30 }] },
      { name: 'B', data: [{ x: 'Feb', y: 5 }, { x: 'Mar', y: 5 }] },
    ];
    const { container } = draw(<AreaChart series={series} stacked width={600} height={300} />);
    const [, aFeb, aMar, bFeb, bMar] = dotsOf(container);
    expect(bFeb.x).toBeCloseTo(aFeb.x);
    expect(bMar.x).toBeCloseTo(aMar.x);
    // B adds the same 5 on top of A in February and in March.
    expect(aFeb.y - bFeb.y).toBeGreaterThan(0);
    expect(aFeb.y - bFeb.y).toBeCloseTo(aMar.y - bMar.y);
  });

  it('keeps a series aligned past a reading it has no value for', () => {
    const series = [
      { name: 'A', data: [{ x: 'Jan', y: 10 }, { x: 'Feb', y: 10 }, { x: 'Mar', y: 10 }] },
      { name: 'B', data: [{ x: 'Jan', y: 5 }, { x: 'Feb', y: null as unknown as number }, { x: 'Mar', y: 5 }] },
    ];
    const { container } = draw(<AreaChart series={series} stacked width={600} height={300} />);
    const [aJan, , aMar, bJan, bMar] = dotsOf(container);
    expect(bJan.x).toBeCloseTo(aJan.x);
    expect(bMar.x).toBeCloseTo(aMar.x);
    expect(bMar.y).toBeCloseTo(bJan.y);
  });
});

describe('a chart under a moving pointer', () => {
  it('LineChart does not read every point out again at each step', () => {
    let formatted = 0;
    const formatX = (value: number | string) => {
      formatted += 1;
      return String(value);
    };
    const series = [0, 1].map((s) => ({ name: `S${s}`, data: Array.from({ length: 200 }, (_, i) => ({ x: i, y: i * (s + 1) })) }));
    const { container } = draw(<LineChart series={series} interactive formatXLabel={formatX} width={600} height={300} />);
    const svg = placeSvg(container);
    formatted = 0;
    pointerAt(svg, 300);
    pointerAt(svg, 320);
    // The axis's few labels and the tooltip's heading, not 400 points twice.
    expect(formatted).toBeLessThan(40);
  });

  it('BarChart redraws only the tooltip as the pointer moves across a bar', () => {
    let formatted = 0;
    const formatValue = (value: number) => {
      formatted += 1;
      return String(value);
    };
    const bars = [{ name: 'B', data: Array.from({ length: 200 }, (_, i) => ({ label: `L${i}`, value: i })) }];
    const { container } = draw(<BarChart series={bars} interactive formatValue={formatValue} />);
    placeSvg(container);
    const bar = container.querySelectorAll('rect')[10];
    act(() => {
      bar.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 10, clientY: 10 }));
    });
    formatted = 0;
    act(() => {
      bar.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 12, clientY: 10 }));
    });
    expect(tooltipOf(container)?.textContent).toContain('L10: 10');
    expect(formatted).toBeLessThan(20);
  });
});

describe('a GaugeChart that does not animate', () => {
  it('draws a new value’s arc in the same pass as its number', () => {
    const seen: Array<string | null> = [];
    function Probe({ value }: { value: number }) {
      const box = React.useRef<HTMLDivElement>(null);
      // Runs once the page's own redraw is on the screen, before any redraw of the gauge's own.
      React.useLayoutEffect(() => {
        seen.push(box.current!.querySelectorAll('path')[1].getAttribute('stroke-dashoffset'));
      });
      return (
        <div ref={box}>
          <GaugeChart value={value} animated={false} />
        </div>
      );
    }
    const view = draw(<Probe value={20} />);
    view.rerender(<Probe value={80} />);
    const settled = view.container.querySelectorAll('path')[1].getAttribute('stroke-dashoffset');
    expect(seen[1]).toBe(settled);
    expect(seen[1]).not.toBe(seen[0]);
  });
});

describe('a series too long to spread into Math.min', () => {
  it('draws rather than throwing', () => {
    const data = Array.from({ length: 130_000 }, (_, i) => ({ x: i, y: (i % 50) - 10 }));
    const { container } = draw(<LineChart series={[{ name: 'log', data, showDots: false }]} ariaLabel="Log" />);
    expect(container.querySelector('path')?.getAttribute('d')?.startsWith('M ')).toBe(true);
    // -10 to 39, padded and rounded out to steps of 20.
    expect(valueLabels(container)).toEqual(['60', '44', '28', '12', '-4', '-20']);
  });
});

describe('SmartStats figures', () => {
  const figures = (container: HTMLElement) =>
    Array.from(container.querySelectorAll<HTMLElement>('.softn-smart-stats > div')).map(
      (card) => card.querySelector('span')?.textContent
    );

  it('shows a figure written with a unit or as a date as written, and only a bare number as a number', () => {
    const { container } = draw(<SmartStats stats="Uptime: 99.9%, Version: 2.0.1, Since: 2024-01-05, Opens: 09:30, Users: 1200" />);
    expect(figures(container)).toEqual(['99.9%', '2.0.1', '2024-01-05', '09:30', '1.2K']);
  });

  it('shortens a large loss as it shortens a large gain, and 999,950 as a million', () => {
    const { container } = draw(
      <SmartStats stats={[{ label: 'Loss', value: -1500000 }, { label: 'Near', value: 999950 }, { label: 'Refunds', value: -2500 }]} />
    );
    expect(figures(container)).toEqual(['-1.5M', '1.0M', '-2.5K']);
  });

  it('draws a trend in the direction its stat names', () => {
    const DOWN = '23 18 13.5 8.5 8.5 13.5 1 6';
    const UP = '23 6 13.5 15.5 8.5 10.5 1 18';
    const { container } = draw(
      <SmartStats
        stats={[
          { label: 'Costs', value: 100, trend: '5%', trendDirection: 'down' },
          { label: 'Churn', value: 3, trend: '-2%', trendDirection: 'up' },
        ]}
      />
    );
    const arrows = Array.from(container.querySelectorAll('.softn-smart-stats > div')).map(
      (card) => card.querySelector('polyline')?.getAttribute('points') ?? null
    );
    expect(arrows).toEqual([DOWN, UP]);
  });
});

describe('SmartCards and SmartList under the pointer', () => {
  const people = Array.from({ length: 30 }, (_, i) => ({ id: i, name: `Person ${i}`, role: 'Staff', status: 'active' }));

  it.each([
    ['SmartCards', () => <SmartCards data={people} title="name" subtitle="role" badges="status" onSelect={() => {}} />],
    ['SmartList', () => <SmartList data={people} primary="name" secondary="role" badge="status" onSelect={() => {}} />],
  ])('%s does not draw itself again as the pointer crosses an item', (_name, render) => {
    let commits = 0;
    const { container } = draw(
      <React.Profiler id="items" onRender={() => (commits += 1)}>
        {render()}
      </React.Profiler>
    );
    commits = 0;
    const item = container.querySelectorAll('[role="button"]')[2];
    act(() => {
      item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    act(() => {
      item.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(commits).toBe(0);
  });
});

describe('text that starts with a date', () => {
  it('SmartView shows it as written, not as "Invalid Date"', () => {
    const { container } = draw(<SmartView data={{ notes: '2024-01-05 call back' }} />);
    expect(container.textContent).toContain('2024-01-05 call back');
    expect(container.textContent).not.toContain('Invalid Date');
  });

  it('SmartTimeline shows it as written, not as "Invalid Date"', () => {
    const { container } = draw(<SmartTimeline data={[{ id: 1, title: 'Call', time: '2024-01-05 evening' }]} />);
    expect(container.textContent).toContain('2024-01-05 evening');
    expect(container.textContent).not.toContain('Invalid Date');
  });
});

describe('a SmartList avatar', () => {
  const avatarBox = (container: HTMLElement) => container.querySelector<HTMLElement>('[role="button"] > div, .softn-smart-list > div > div');

  it('draws an image address as the image, not as its initials', () => {
    // jsdom drops a `background` it cannot parse, so the style is read as React writes it.
    const html = renderToStaticMarkup(
      <SmartList data={[{ id: 1, name: 'Ann Lee', photo: 'https://example.com/ann.png' }]} avatar="photo" />
    );
    expect(html).toContain('background:url(&quot;https://example.com/ann.png&quot;) center/cover');
    const { container } = draw(<SmartList data={[{ id: 1, name: 'Ann Lee', photo: 'https://example.com/ann.png' }]} avatar="photo" />);
    expect(avatarBox(container)!.textContent).toBe('');
  });

  it('still draws a name as its initials, and never an unsafe address', () => {
    const { container } = draw(
      <SmartList
        data={[
          { id: 1, name: 'Ann Lee' },
          { id: 2, name: 'Bo Ek', photo: 'javascript:alert(1)' },
        ]}
        avatar="name"
      />
    );
    expect(container.textContent).toContain('AL');
    const unsafe = draw(<SmartList data={[{ id: 2, name: 'Bo Ek', photo: 'javascript:alert(1)' }]} avatar="photo" />);
    expect(unsafe.container.innerHTML).not.toMatch(/javascript:/i);
  });
});
