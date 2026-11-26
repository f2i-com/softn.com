/**
 * The smart components and the charts, round four: what round three's fixes
 * left wrong or made wrong, and what was still wrong beside them.
 */

import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type as typeInto, type Mounted } from './dom';
import { SmartForm } from '../src/smart/SmartForm';
import { SmartList } from '../src/smart/SmartList';
import { SmartCards } from '../src/smart/SmartCards';
import { SmartTimeline } from '../src/smart/SmartTimeline';
import { SmartGrid } from '../src/smart/SmartGrid';
import { SmartStats } from '../src/smart/SmartStats';
import { LineChart } from '../src/charts/LineChart';
import { AreaChart } from '../src/charts/AreaChart';
import { BarChart } from '../src/charts/BarChart';
import { RadarChart } from '../src/charts/RadarChart';

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

function submitForm(container: HTMLElement) {
  act(() => {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

const alerts = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[role="alert"]')).map((alert) => alert.id.replace(/^.*-(\w+)-error$/, '$1'));

describe('a SmartForm whose page keeps what is typed in it', () => {
  const fields = [
    { name: 'name', type: 'text' as const, required: true },
    { name: 'email', type: 'text' as const, required: true },
  ];

  /** `data={draft}`, with `onChange` keeping `draft`: the form handed back what it said. */
  function Page({ record }: { record?: Record<string, unknown> }) {
    const [draft, setDraft] = React.useState<Record<string, unknown>>(record ?? {});
    React.useEffect(() => {
      if (record) setDraft(record);
    }, [record]);
    return <SmartForm fields={fields} data={draft} onChange={setDraft} onSubmit={() => {}} />;
  }

  it('keeps every other field’s error when one field is typed in after a refused submit', () => {
    const { container } = draw(<Page />);
    submitForm(container);
    expect(alerts(container)).toEqual(['name', 'email']);

    typeInto(container.querySelector<HTMLInputElement>('input[name="name"]'), 'Ann');
    // The field typed in is put right; the one still empty still says so.
    expect(alerts(container)).toEqual(['email']);
    expect(container.querySelector('input[name="email"]')!.getAttribute('aria-invalid')).toBe('true');
  });

  it('still leaves the errors behind when the page moves it to another record', () => {
    const view = draw(<Page />);
    submitForm(view.container);
    expect(alerts(view.container)).toEqual(['name', 'email']);
    view.rerender(<Page record={{ name: 'Bea', email: 'bea@example.com' }} />);
    expect(view.container.querySelector<HTMLInputElement>('input[name="name"]')!.value).toBe('Bea');
    expect(alerts(view.container)).toEqual([]);
  });
});

/** Whether `text` holds half of a surrogate pair: what draws as the replacement character. */
const halfACharacter = (text: string | null | undefined) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text ?? '');

describe('initials of a name that starts outside the basic plane', () => {
  const name = '\u{1D4D0}nn Lee';
  const initials = '\u{1D4D0}L';

  it('SmartList draws the whole first character', () => {
    const { container } = draw(<SmartList data={[{ id: 1, name }]} primary="name" avatar="name" />);
    const avatar = container.querySelector('.softn-smart-list-item > div')!;
    expect(halfACharacter(avatar.textContent)).toBe(false);
    expect(avatar.textContent).toBe(initials);
  });

  it('SmartList draws an emoji whole too', () => {
    const { container } = draw(<SmartList data={[{ id: 1, name: '\u{1F600} Party' }]} primary="name" avatar="name" />);
    expect(container.querySelector('.softn-smart-list-item > div')!.textContent).toBe('\u{1F600}P');
  });

  it('SmartCards draws the whole first character', () => {
    const { container } = draw(<SmartCards data={[{ id: 1, name }]} title="name" />);
    const avatar = container.querySelector('.softn-smart-card > div > div')!;
    expect(halfACharacter(avatar.textContent)).toBe(false);
    expect(avatar.textContent).toBe(initials);
  });

  it('SmartTimeline draws the whole first character of its actor', () => {
    const { container } = draw(<SmartTimeline data={[{ id: 1, title: 'Called', actor: name }]} actor="actor" />);
    const actorName = Array.from(container.querySelectorAll('span')).find((span) => span.textContent === name)!;
    const avatar = actorName.previousElementSibling!;
    expect(halfACharacter(avatar.textContent)).toBe(false);
    expect(avatar.textContent).toBe(initials);
  });

  it('still takes the first letters of the first two words of a plain name', () => {
    const { container } = draw(<SmartList data={[{ id: 1, name: 'ann marie lee' }]} primary="name" avatar="name" />);
    expect(container.querySelector('.softn-smart-list-item > div')!.textContent).toBe('AM');
  });
});

describe('a record day in a year below 100', () => {
  it('SmartGrid shows the year as written, not as 19yy', () => {
    const day = new Date(2000, 5, 1);
    day.setFullYear(50, 5, 1);
    const expected = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(day);
    const { container } = draw(<SmartGrid data={[{ id: 1, due: '0050-06-01' }, { id: 2, due: '0001-02-29' }]} columns="due" />);
    const cells = Array.from(container.querySelectorAll('tbody td')).map((cell) => cell.textContent);
    expect(cells[0]).toBe(expected);
    expect(cells[0]).not.toContain('1950');
    // Year 1 had no 29 February: as written, as any day that is not on the calendar is.
    expect(cells[1]).toBe('0001-02-29');
  });
});

describe('SmartStats figures just under a thousand', () => {
  const figures = (container: HTMLElement) =>
    Array.from(container.querySelectorAll<HTMLElement>('.softn-smart-stats > div')).map(
      (card) => card.querySelector('span')?.textContent
    );

  it('shows a figure that rounds to a thousand in thousands, not as "1000.0"', () => {
    const { container } = draw(
      <SmartStats
        stats={[
          { label: 'A', value: 999.96 },
          { label: 'B', value: -999.99 },
          { label: 'C', value: 999.94 },
          { label: 'D', value: 999 },
        ]}
      />
    );
    expect(figures(container)).toEqual(['1.0K', '-1.0K', '999.9', '999']);
  });
});

describe('a chart’s legend and tooltip swatches', () => {
  // A colour the charts cannot draw (safeSvgPaint takes no color-mix): the
  // series is drawn in the palette's colour, and its swatch said another.
  const mixed = 'color-mix(in srgb, red 50%, blue)';

  it.each([
    ['LineChart', () => <LineChart series={[{ name: 'A', color: mixed, data: [{ x: 0, y: 1 }, { x: 1, y: 2 }] }, { name: 'B', data: [{ x: 0, y: 2 }] }]} />],
    ['AreaChart', () => <AreaChart series={[{ name: 'A', color: mixed, data: [{ x: 0, y: 1 }, { x: 1, y: 2 }] }, { name: 'B', data: [{ x: 0, y: 2 }] }]} />],
    ['BarChart', () => <BarChart series={[{ name: 'A', color: mixed, data: [{ label: 'Q1', value: 1 }] }, { name: 'B', data: [{ label: 'Q1', value: 2 }] }]} />],
    [
      'RadarChart',
      () => (
        <RadarChart
          axes={['speed', 'range']}
          series={[{ name: 'A', color: mixed, data: [{ axis: 'speed', value: 1 }] }, { name: 'B', data: [{ axis: 'range', value: 2 }] }]}
        />
      ),
    ],
  ])('%s shows a series in its legend in the colour it is drawn in', (_name, render) => {
    const html = renderToStaticMarkup(render());
    expect(html).not.toContain('color-mix');
    // The first series is drawn, and its swatch shown, in the palette's first colour.
    expect(html).toMatch(/background-color:var\(--color-chart-1, #6366f1\)/);
  });

  it.each([
    ['LineChart', LineChart],
    ['AreaChart', AreaChart],
  ] as const)('%s shows a series in its tooltip in the colour it is drawn in', (_name, Chart) => {
    const series = [
      { name: 'A', color: mixed, data: [{ x: 0, y: 1 }, { x: 1, y: 2 }] },
      { name: 'B', data: [{ x: 0, y: 2 }, { x: 1, y: 3 }] },
    ];
    const { container } = draw(<Chart series={series} interactive width={600} height={300} showLegend={false} />);
    const svg = container.querySelector('svg')!;
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 300, width: 600, height: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    act(() => {
      svg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 60, clientY: 100 }));
    });
    const tooltip = Array.from(container.querySelectorAll<HTMLElement>('div')).find(
      (div) => div.style.position === 'absolute' && div.style.pointerEvents === 'none'
    )!;
    const swatch = tooltip.querySelector<HTMLElement>('span')!;
    expect(swatch.style.backgroundColor).not.toBe('');
    expect(swatch.style.backgroundColor).not.toContain('color-mix');
    expect(swatch.style.backgroundColor.replace(/\s/g, '')).toBe('var(--color-chart-1,#6366f1)');
  });
});
