/**
 * Four things that were drawn other than as they were meant, found by
 * looking at a page of the everyday components in a browser.
 *
 * A Switch that is on had no colour. Its track's gradient was written to
 * `background-color`, which takes a colour and not an image: the browser
 * kept the declaration (a value with `var()` in it is only judged later) and
 * drew nothing for it, so on and off differed by where the thumb sat and a
 * faint glow.
 *
 * A Progress asked to show its figure drew it inside the bar whatever the
 * bar's height: 12 px text in an 8 px bar, clipped to a smear, and no figure
 * at all on the two thinnest bars.
 *
 * A TextArea was as wide as its `cols`, about twenty characters, beside
 * inputs that fill the form they are in, and stuck out of a narrow card.
 *
 * An Accordion took `header` for an item's heading and drew a blank one for
 * `title` or `label`, which is what a list, a tab and a step call theirs.
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Switch } from '../src/form/Switch';
import { TextArea } from '../src/form/TextArea';
import { Input } from '../src/form/Input';
import { Progress } from '../src/display/Progress';
import { Accordion } from '../src/utility/Accordion';
import { builtinComponents } from '../src/registry';

const markup = (element: React.ReactElement) => renderToStaticMarkup(element);

/** The style attribute of the first element whose style mentions `needle`. */
function styleWith(html: string, needle: string): string {
  const found = [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]).find((style) => style.includes(needle));
  if (found === undefined) throw new Error(`no style mentions ${needle} in ${html.slice(0, 300)}`);
  return found;
}

/** A declaration that hands an image to a property that takes a colour. */
const COLOUR_GIVEN_AN_IMAGE = /(?:^|;|")\s*(?:background-color|color|border(?:-[a-z]+)?-color|outline-color|fill|stroke):[^;"]*gradient\(/;

describe('a Switch that is on', () => {
  it('has its colour on the track', () => {
    const html = markup(<Switch checked label="Dark mode" />);
    const track = styleWith(html, 'border-radius:9999px');
    expect(track).toMatch(/background:linear-gradient\(/);
    expect(html).not.toMatch(COLOUR_GIVEN_AN_IMAGE);
  });

  it('takes a colour of the app’s for it', () => {
    const track = styleWith(markup(<Switch checked onColor="rebeccapurple" />), 'border-radius:9999px');
    expect(track).toContain('background:rebeccapurple');
  });

  it('is grey when it is off, as it was', () => {
    const track = styleWith(markup(<Switch label="Off" />), 'border-radius:9999px');
    expect(track).toMatch(/background:var\(--color-gray-300/);
    expect(track).not.toContain('gradient');
  });
});

describe('no component hands a gradient to a property that takes a colour', () => {
  const components = builtinComponents as unknown as Record<string, React.ComponentType<Record<string, unknown>>>;
  // Drawn as the bare tag; the states a bare tag does not reach are held by
  // each component's own tests (the Switch above).
  it.each(Object.keys(components).filter((tag) => !['QRReader', 'Camera', 'Scene3D'].includes(tag)).sort())('%s', (tag) => {
    let html = '';
    try {
      html = markup(React.createElement(components[tag]));
    } catch {
      return; // What cannot be drawn without a browser is not what this is about.
    }
    expect(html).not.toMatch(COLOUR_GIVEN_AN_IMAGE);
  });
});

describe('a Progress showing its figure', () => {
  const figure = (html: string) => {
    const spans = [...html.matchAll(/<span([^>]*)>(\d+%)<\/span>/g)];
    return spans.map((m) => ({ inside: /position:absolute/.test(m[1]), text: m[2] }));
  };

  it('draws it beside a bar that is too thin to hold it', () => {
    for (const size of ['xs', 'sm', 'md'] as const) {
      const shown = figure(markup(<Progress value={72} showLabel size={size} />));
      expect(shown, size).toEqual([{ inside: false, text: '72%' }]);
    }
  });

  it('draws it inside a bar that is tall enough', () => {
    for (const size of ['lg', 'xl'] as const) {
      const shown = figure(markup(<Progress value={72} showLabel size={size} />));
      expect(shown, size).toEqual([{ inside: true, text: '72%' }]);
    }
  });

  it('still puts it where it is asked to', () => {
    expect(figure(markup(<Progress value={72} showLabel labelPosition="outside" size="xl" />))).toEqual([{ inside: false, text: '72%' }]);
    expect(markup(<Progress value={72} showLabel labelPosition="top" />)).toContain('72%');
    expect(figure(markup(<Progress value={72} />))).toEqual([]);
    expect(figure(markup(<Progress value={72} showLabel indeterminate />))).toEqual([]);
  });
});

describe('a TextArea', () => {
  it('fills the width it is given, as an Input does', () => {
    const area = styleWith(markup(<TextArea label="About" />), 'resize:');
    expect(area).toContain('width:100%');
    expect(area).toContain('box-sizing:border-box');
    expect(area).toContain('display:block');
    // The Input's field has always filled its wrapper.
    expect(markup(<Input label="Name" />)).toContain('width:100%');
  });

  it('cannot be dragged wider than what it is in', () => {
    expect(styleWith(markup(<TextArea resize="both" />), 'resize:')).toContain('max-width:100%');
  });
});

describe('a layout that changes with the width of the screen', () => {
  // Grid and Stack write the layout for one width as an inline style and
  // the layout for another as a media rule on their id. A rule in a
  // stylesheet does not outrank an inline style, so none of these rules ever
  // applied: `collapseOnMobile` was one column on a desktop, `mobileVertical`
  // a row on a phone. (Seen in a browser; held here by the one thing that
  // decides it.)
  function rules(html: string, property: string): string[] {
    const sheet = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
    return [...sheet.matchAll(new RegExp(`${property}:([^;}]*)`, 'g'))].map((m) => m[1].trim());
  }

  const Grid = (builtinComponents as unknown as Record<string, React.ComponentType<Record<string, unknown>>>).Grid;
  const Stack = (builtinComponents as unknown as Record<string, React.ComponentType<Record<string, unknown>>>).Stack;

  it.each([
    ['collapseOnMobile', { columns: 3, collapseOnMobile: true }, 1],
    ['responsive', { columns: 4, responsive: true }, 3],
    ['a columns object', { columns: { sm: 1, md: 2, lg: 3, xl: 4 } }, 3],
  ])('a Grid with %s: each wider layout outranks the inline one', (_name, props, count) => {
    const html = markup(React.createElement(Grid, props));
    expect(styleWith(html, 'display:grid')).toContain('grid-template-columns:');
    const written = rules(html, 'grid-template-columns');
    expect(written).toHaveLength(count);
    for (const rule of written) expect(rule).toMatch(/^repeat\(\d+, 1fr\) !important$/);
  });

  it.each([
    ['mobileVertical', { direction: 'horizontal', mobileVertical: true }, 'column !important'],
    ['mobileHorizontal', { direction: 'vertical', mobileHorizontal: true }, 'row !important'],
    ['mobileReverse', { direction: 'horizontal', mobileVertical: true, mobileReverse: true }, 'column-reverse !important'],
  ])('a Stack with %s: the phone layout outranks the inline one', (_name, props, expected) => {
    const html = markup(React.createElement(Stack, props));
    expect(styleWith(html, 'display:flex')).toContain('flex-direction:');
    expect(rules(html, 'flex-direction')).toEqual([expected]);
  });

  it('a plain Grid or Stack writes no rules at all', () => {
    expect(markup(React.createElement(Grid, { columns: 3 }))).not.toContain('<style>');
    expect(markup(React.createElement(Stack, { direction: 'horizontal' }))).not.toContain('<style>');
  });
});

describe('an Accordion item', () => {
  const items = (heading: Record<string, string>) => [{ key: 'a', content: 'Everything on this page.', ...heading }];

  it('is headed by its header', () => {
    expect(markup(<Accordion items={items({ header: 'What is included?' }) as never} />)).toContain('What is included?');
  });

  it('is headed by its title or its label, where it used to be blank', () => {
    expect(markup(<Accordion items={items({ title: 'What is included?' }) as never} />)).toContain('What is included?');
    expect(markup(<Accordion items={items({ label: 'Can I change my plan?' }) as never} />)).toContain('Can I change my plan?');
  });

  it('prefers the header when it is given more than one', () => {
    const html = markup(<Accordion items={items({ header: 'Header', title: 'Title' }) as never} />);
    expect(html).toContain('Header');
    expect(html).not.toContain('Title');
  });
});
