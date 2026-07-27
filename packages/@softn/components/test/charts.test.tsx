/**
 * Charts with data the author did not picture.
 *
 * A chart that renders *something* for bad input is worse than one that
 * errors: a loss reads as zero, or an axis quietly disagrees with the line
 * drawn against it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from './dom';
import { LineChart } from '../src/charts/LineChart';
import { BarChart } from '../src/charts/BarChart';
import { AreaChart } from '../src/charts/AreaChart';

beforeEach(() => {
  document.body.innerHTML = '';
});

/** Every numeric attribute value in the rendered SVG. */
function numericAttrs(container: HTMLElement, attr: string): number[] {
  return Array.from(container.querySelectorAll(`[${attr}]`))
    .map((el) => Number(el.getAttribute(attr)))
    .filter((n) => !Number.isNaN(n));
}

function textContents(container: HTMLElement): string {
  return container.textContent ?? '';
}

describe('a series that is entirely negative', () => {
  const series = [{ name: 'pnl', data: [{ x: 0, y: -100 }, { x: 1, y: -105 }] }];

  it('does not invert the LineChart domain', () => {
    // rawYMax scaled a negative maximum *downward* (-100 * 1.1 = -110), so the
    // top of the axis sat below the bottom and every point mapped off-canvas.
    const { container } = mount(<LineChart series={series} height={300} />);
    const ys = numericAttrs(container, 'cy');
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(300);
    }
  });

  it('does not render NaN in the LineChart', () => {
    const { container } = mount(<LineChart series={series} />);
    expect(textContents(container)).not.toMatch(/NaN|Infinity/);
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it('does the same for AreaChart', () => {
    const { container } = mount(<AreaChart series={series} />);
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });
});

describe('a bar chart with a loss in it', () => {
  const series = [
    { name: 'P&L', data: [{ label: 'Q1', value: 100 }, { label: 'Q2', value: -40 }] },
  ];

  it('never asks for a negative rect height', () => {
    // SVG treats a negative height as an error and skips the element, so the
    // loss simply vanished while its axis label stayed — reading as zero.
    const { container } = mount(<BarChart series={series} height={300} />);
    for (const h of numericAttrs(container, 'height')) {
      expect(h).toBeGreaterThanOrEqual(0);
    }
    for (const w of numericAttrs(container, 'width')) {
      expect(w).toBeGreaterThanOrEqual(0);
    }
  });

  it('draws a bar for every value', () => {
    const { container } = mount(<BarChart series={series} height={300} />);
    const bars = container.querySelectorAll('rect[height]');
    expect(bars.length).toBeGreaterThanOrEqual(2);
  });
});

describe('a chart bound to data that has not arrived', () => {
  it('renders an empty LineChart without NaN or -Infinity labels', () => {
    // `Math.max(...[])` is -Infinity, which is truthy, so the `|| 1` guard
    // never fired and the axis rendered "-Infinityk" with five NaN ticks.
    const { container } = mount(<LineChart series={[]} />);
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it('renders an empty BarChart the same way', () => {
    const { container } = mount(<BarChart series={[]} />);
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it('renders a series whose data array is empty', () => {
    const { container } = mount(<LineChart series={[{ name: 'a', data: [] }]} />);
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });
});

describe('ordinary positive data', () => {
  it('still renders as before', () => {
    const { container } = mount(
      <LineChart series={[{ name: 'a', data: [{ x: 0, y: 10 }, { x: 1, y: 20 }] }]} />
    );
    expect(container.querySelectorAll('path,polyline,circle').length).toBeGreaterThan(0);
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });
});

describe('bar chart layouts that were already working', () => {
  const positive = [
    { name: 'a', data: [{ label: 'Q1', value: 30 }, { label: 'Q2', value: 70 }] },
    { name: 'b', data: [{ label: 'Q1', value: 20 }, { label: 'Q2', value: 10 }] },
  ];

  it('still stacks', () => {
    const { container } = mount(<BarChart series={positive} stacked height={300} />);
    const rects = Array.from(container.querySelectorAll('rect[height]'));
    expect(rects.length).toBeGreaterThanOrEqual(4);
    for (const r of rects) expect(Number(r.getAttribute('height'))).toBeGreaterThanOrEqual(0);
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it('still groups', () => {
    const { container } = mount(<BarChart series={positive} grouped height={300} />);
    expect(container.querySelectorAll('rect[height]').length).toBeGreaterThanOrEqual(4);
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it('still renders horizontally', () => {
    const { container } = mount(<BarChart series={positive} orientation="horizontal" />);
    for (const w of numericAttrs(container, 'width')) expect(w).toBeGreaterThanOrEqual(0);
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it('renders a horizontal chart with a loss without negative width', () => {
    const { container } = mount(
      <BarChart
        series={[{ name: 'p', data: [{ label: 'Q1', value: 50 }, { label: 'Q2', value: -20 }] }]}
        orientation="horizontal"
      />
    );
    for (const w of numericAttrs(container, 'width')) expect(w).toBeGreaterThanOrEqual(0);
  });

  it('puts the taller bar of a pair further from the baseline', () => {
    // A sanity check that the new baseline maths still orders bars correctly.
    const { container } = mount(
      <BarChart series={[{ name: 'a', data: [{ label: 'S', value: 10 }, { label: 'L', value: 90 }] }]} height={300} />
    );
    const heights = Array.from(container.querySelectorAll('rect[height]'))
      .map((r) => Number(r.getAttribute('height')))
      .filter((h) => h > 0)
      .sort((a, b) => a - b);
    expect(heights.length).toBeGreaterThanOrEqual(2);
    expect(heights[heights.length - 1]).toBeGreaterThan(heights[0]);
  });
});
