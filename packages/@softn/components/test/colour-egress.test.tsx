/**
 * Colour props that the component paints into `background`.
 *
 * A `background` prop may legitimately be an image and is judged against the
 * app's `net` permission (style-egress.test.tsx). A colour prop never needs
 * to load anything, but a dozen components copied theirs into `background`
 * or interpolated it into a gradient there — `<Progress color="url(https://
 * attacker/x)">` painted, and so fetched, with no `net` grant and before the
 * user had answered the consent bar. These pin that such a prop paints
 * colours and gradients only, whatever the policy says, and that an ordinary
 * colour is untouched.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { Progress } from '../src/display/Progress';
import { Split } from '../src/layout/Split';
import { ColorPicker } from '../src/form/ColorPicker';
import { Avatar } from '../src/display/Avatar';
import { Spinner } from '../src/display/Spinner';
import { Card } from '../src/layout/Card';
import { DPad } from '../src/utility/DPad';
import { PixelGrid } from '../src/utility/PixelGrid';
import { SmartStats } from '../src/smart/SmartStats';
import { Skeleton } from '../src/display/Skeleton';
import { Grid } from '../src/layout/Grid';
import { SmartCards } from '../src/smart/SmartCards';
import { cssColumnCount, cssPaint } from '../src/utils/egress';
import { click, mount } from './dom';

beforeEach(() => {
  document.body.innerHTML = '';
});

const REMOTE = 'url(https://attacker.example/x)';

/** Every spelling of a fetch a colour prop has been handed. */
const LOADS = [
  REMOTE,
  'URL(https://attacker.example/x)',
  'red url(https://attacker.example/x)',
  // Closes the gradient the component interpolates into and opens a layer.
  'red), url(https://attacker.example/x), linear-gradient(red',
  'image-set(https://attacker.example/x 1x)',
  '-webkit-image-set(https://attacker.example/x 1x)',
  'u\\72l(https://attacker.example/x)',
  'u/**/rl(https://attacker.example/x)',
  "url('https://attacker.example/x')",
  'red; background-image: url(https://attacker.example/x)',
  '@import https://attacker.example/x',
];

describe('cssPaint', () => {
  it.each(LOADS)('refuses %s', (value) => {
    expect(cssPaint(value)).toBeUndefined();
  });

  it.each([
    'red',
    '#6366f1',
    'rgba(255, 255, 255, 0.15)',
    'hsl(210 40% 50% / 0.5)',
    'var(--color-primary-500, #6366f1)',
    'color-mix(in srgb, red 50%, blue)',
    'linear-gradient(135deg, #111 0%, #222 100%)',
    'transparent',
  ])('keeps %s', (value) => {
    expect(cssPaint(value)).toBe(value);
  });
});

const components: Array<[string, (colour: string) => React.ReactElement]> = [
  ['Progress color', (c) => <Progress value={50} color={c} />],
  ['Progress backgroundColor', (c) => <Progress value={50} backgroundColor={c} />],
  [
    'Split gutterColor',
    (c) => (
      <Split gutterColor={c}>
        <div>a</div>
        <div>b</div>
      </Split>
    ),
  ],
  ['ColorPicker value', (c) => <ColorPicker value={c} />],
  ['Avatar badgeColor', (c) => <Avatar name="Ada" badge={3} badgeColor={c} />],
  ['Spinner color', (c) => <Spinner color={c} />],
  ['Card gradientFrom', (c) => <Card variant="gradient" gradientFrom={c}>x</Card>],
  ['Card gradientTo', (c) => <Card variant="gradient" gradientTo={c}>x</Card>],
  ['DPad color', (c) => <DPad color={c} />],
  ['PixelGrid gridColor', (c) => <PixelGrid rows={2} cols={2} gridColor={c} />],
  ['SmartStats stat colour', (c) => <SmartStats stats={[{ label: 'a', value: 1, color: c }]} variant="gradient" />],
  ['SmartStats stat colour (tint)', (c) => <SmartStats stats={[{ label: 'a', value: 1, color: c, icon: 'star' }]} />],
  ['Skeleton highlightColor', (c) => <Skeleton highlightColor={c} animation="wave" />],
];

describe.each(components)('%s', (_name, render) => {
  it.each(LOADS)('never paints %s', (value) => {
    const { container } = mount(render(value));
    expect(container.innerHTML).not.toContain('attacker.example');
  });

  it('paints an ordinary colour', () => {
    const { container } = mount(render('#010203'));
    expect(container.innerHTML).toMatch(/rgb\(1, 2, 3\)|#010203/i);
  });
});

describe('ColorPicker presets', () => {
  it('paints colour swatches and refuses anything that loads', () => {
    const { container } = mount(<ColorPicker presets={['#123456', REMOTE]} />);
    click(container.querySelector('[style*="cursor: pointer"]'));
    // A swatch's `title` names the preset; only what it paints is at issue.
    expect(container.querySelectorAll('button[title]')).toHaveLength(2);
    const styles = Array.from(container.querySelectorAll('[style]'), (el) => el.getAttribute('style')).join('\n');
    expect(styles).not.toContain('attacker.example');
    expect(styles).toMatch(/#123456|rgb\(18, 52, 86\)/i);
  });
});

// The responsive grids write their column counts into <style> text, where a
// string closes the rule and adds one of its own.
describe('column counts written into a stylesheet', () => {
  const INJECT = '1fr); } body { background: url(https://attacker.example/x) } x { a: (';

  it('cssColumnCount accepts a whole number and nothing else', () => {
    expect(cssColumnCount(3, 1)).toBe(3);
    expect(cssColumnCount('4', 1)).toBe(4);
    expect(cssColumnCount(INJECT, 2)).toBe(2);
    expect(cssColumnCount(1.5, 2)).toBe(2);
    expect(cssColumnCount(0, 2)).toBe(2);
  });

  it('Grid', () => {
    const columns = { sm: 1, md: INJECT, lg: INJECT } as unknown as { sm: number; md: number; lg: number };
    const { container } = mount(
      <Grid columns={columns}>
        <div>a</div>
      </Grid>
    );
    expect(container.innerHTML).not.toContain('attacker.example');
  });

  it('SmartCards', () => {
    const columns = { sm: INJECT, md: INJECT } as unknown as { sm: number; md: number };
    const { container } = mount(<SmartCards data={[{ id: '1', name: 'a' }]} title="name" columns={columns} />);
    expect(container.innerHTML).not.toContain('attacker.example');
  });
});

// The decoder <QRReader> scans with used to be fetched from jsDelivr on the
// first frame, whatever the app's `net` permission said.
describe('the QR decoder', () => {
  it('is located on the host, never on a CDN', async () => {
    vi.resetModules();
    const prepare = vi.fn();
    vi.doMock('@yudiel/react-qr-scanner', () => ({ Scanner: () => null, prepareZXingModule: prepare }));
    await import('../src/utility/QRReader');
    expect(prepare).toHaveBeenCalledTimes(1);
    const locateFile = prepare.mock.calls[0][0].overrides.locateFile as (path: string, prefix: string) => string;
    const url = locateFile('zxing_reader.wasm', 'https://fastly.jsdelivr.net/npm/zxing-wasm@2.2.4/dist/reader/');
    expect(url).not.toMatch(/jsdelivr|^https?:/);
    expect(url).toMatch(/zxing_reader.*\.wasm/);
    vi.doUnmock('@yudiel/react-qr-scanner');
  });
});
