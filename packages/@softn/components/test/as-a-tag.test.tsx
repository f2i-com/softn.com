/**
 * A component written as a tag in a page is the component React would draw.
 *
 * The renderer handed every tag with nothing inside it an empty list of
 * children, where JSX hands none, and a component that asks "was I given
 * children?" took the list for a yes. `<Avatar name="Ada Lovelace" />` in a
 * page drew its absent children where the initials (or the picture) belong
 * and lost the role and name a screen reader reads; an Alert with only a
 * title kept an empty box, and its margin, for the message. Mounted directly
 * in a test, as every component's own tests mount it, none of that showed.
 *
 * So each registered component is drawn both ways, bare and with the props
 * Builder gives it, and the two are held to be the same markup.
 *
 * And the Radio group bound with `:bind`, which was wired as one radio
 * input: it showed no choice and wrote `undefined` when one was made.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComponentRegistry, parse, renderDocument, type SoftNComponent, type SoftNRenderContext } from '@softn/core';
import { mount } from './dom';
import { builtinComponents } from '../src/registry';

// The scanner library asks its canvas for a 2D context as it mounts, which
// jsdom does not have.
vi.mock('@yudiel/react-qr-scanner', () => ({
  prepareZXingModule: () => {},
  Scanner: (): React.ReactElement => React.createElement('video'),
}));

const components = builtinComponents as unknown as Record<string, React.ComponentType<Record<string, unknown>>>;
const registry = new ComponentRegistry();
registry.registerAll(builtinComponents as unknown as Record<string, SoftNComponent>);

function context(state: Record<string, unknown> = {}, writes: Array<[string, unknown]> = []): SoftNRenderContext {
  return {
    state,
    setState: (path: string, value: unknown) => writes.push([path, value]),
    data: {},
    props: {},
    computed: {},
    functions: {},
    asyncFunctions: {},
  } as SoftNRenderContext;
}

/** Marquee names its animation at random on every mount; the name is the only thing that differs. */
function settled(markup: string): string {
  return markup.replace(/marquee-[a-z0-9]+/g, 'marquee-name');
}

/**
 * Where the renderer puts a component: inside its error boundary, in a
 * list. The ids React makes up (`useId`) depend on that position, so the
 * component is drawn directly from the same one.
 */
class Placed extends React.Component<{ children: React.ReactNode }> {
  render(): React.ReactNode {
    return this.props.children;
  }
}

function quietly<T>(draw: () => T): T {
  const spies = [vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})];
  try {
    return draw();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

/** What a page draws for `source`. */
function page(source: string, state: Record<string, unknown> = {}): string {
  const doc = parse(source);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  return quietly(() => settled(renderToStaticMarkup(<>{renderDocument(doc, context(state), registry)}</>)));
}

/** What React draws for the component itself. */
function direct(tag: string, props: Record<string, unknown> = {}): string {
  const placed = [<Placed key="tag">{React.createElement(components[tag], props)}</Placed>];
  return quietly(() => settled(renderToStaticMarkup(<>{placed}</>)));
}

describe('a bare tag is the component with nothing given', () => {
  it.each(Object.keys(components).sort())('<%s />', (tag) => {
    expect(page(`<${tag} />`)).toBe(direct(tag));
    // A closing tag with nothing before it is no different.
    expect(page(`<${tag}></${tag}>`)).toBe(direct(tag));
  });
});

describe('what was drawn wrong for a tag with nothing inside it', () => {
  it('an Avatar shows the initials of its name, and says who it is', () => {
    const markup = page('<Avatar name="Ada Lovelace" />');
    expect(markup).toContain('>AL<');
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Ada Lovelace"');
    expect(markup).toBe(direct('Avatar', { name: 'Ada Lovelace' }));
  });

  it('an Avatar shows its picture', () => {
    const markup = page('<Avatar src="/people/ada.png" name="Ada Lovelace" />');
    expect(markup).toContain('<img src="/people/ada.png"');
  });

  it('an Avatar still shows what is put inside it instead', () => {
    expect(page('<Avatar name="Ada Lovelace"><Icon name="star" /></Avatar>')).not.toContain('>AL<');
  });

  it('an Alert with only a title keeps no box for a message it does not have', () => {
    expect(page('<Alert title="Saved" />')).toBe(direct('Alert', { title: 'Saved' }));
    expect(page('<Alert title="Saved">On every device.</Alert>')).toContain('On every device.');
  });
});

describe('the Radio group bound to state', () => {
  const source =
    '<Radio :bind={plan} label="Plan" options={[{ value: "solo", label: "Solo" }, { value: "team", label: "Team" }, { value: "org", label: "Organisation" }]} />';

  it('shows the option the state holds', () => {
    const doc = parse(source);
    const { container, unmount } = mount(<>{renderDocument(doc, context({ plan: 'team' }), registry)}</>);
    const radios = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    expect(radios.map((radio) => [radio.value, radio.checked])).toEqual([
      ['solo', false],
      ['team', true],
      ['org', false],
    ]);
    unmount();
  });

  it('writes the option chosen', () => {
    const doc = parse(source);
    const writes: Array<[string, unknown]> = [];
    const { container, unmount } = mount(<>{renderDocument(doc, context({ plan: 'team' }, writes), registry)}</>);
    const radios = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    radios[2].click();
    expect(writes).toEqual([['plan', 'org']]);
    unmount();
  });
});
