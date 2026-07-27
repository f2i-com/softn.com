/**
 * Renderer semantics regressions.
 *
 * Each of these produced silently wrong output — the worst kind, because
 * nothing errors and the page merely says something untrue.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry } from '../src/renderer';
import type { SoftNRenderContext, SoftNProps } from '../src/types';

const Passthrough: React.FC<SoftNProps> = ({ children }) =>
  React.createElement('span', null, children as React.ReactNode);

function registry(): ComponentRegistry {
  const r = new ComponentRegistry();
  r.register('Text', Passthrough);
  r.register('Stack', Passthrough);
  r.register('Button', ({ onClick, children }: SoftNProps) =>
    React.createElement('button', { onClick: onClick as () => void }, children as React.ReactNode)
  );
  return r;
}

function context(overrides: Partial<SoftNRenderContext> = {}): SoftNRenderContext {
  return {
    state: {},
    setState: () => {},
    data: {},
    props: {},
    functions: {},
    asyncFunctions: {},
    computed: {},
    ...overrides,
  };
}

/** Render a .ui source to static markup. */
function render(source: string, ctx: SoftNRenderContext): string {
  return renderToStaticMarkup(
    renderDocument(parse(source), ctx, registry()) as React.ReactElement
  );
}

describe('boolean interpolation', () => {
  it('renders nothing for a false guard, as JSX does', () => {
    // `{ready && "Go"}` yields false when the guard fails; printing it put the
    // word "false" on the page, which is exactly what the idiom avoids.
    const html = render('<Text>[{ready && "Go"}]</Text>', context({ state: { ready: false } }));
    expect(html).toContain('[]');
    expect(html).not.toContain('false');
  });

  it('renders nothing for a true boolean too', () => {
    const html = render('<Text>[{flag}]</Text>', context({ state: { flag: true } }));
    expect(html).toContain('[]');
    expect(html).not.toContain('true');
  });

  it('still renders the value when the guard passes', () => {
    const html = render('<Text>[{ready && "Go"}]</Text>', context({ state: { ready: true } }));
    expect(html).toContain('[Go]');
  });

  it('still renders zero and empty strings', () => {
    expect(render('<Text>[{n}]</Text>', context({ state: { n: 0 } }))).toContain('[0]');
    expect(render('<Text>[{s}]</Text>', context({ state: { s: '' } }))).toContain('[]');
  });
});

describe('each combined with if', () => {
  const items = [
    { name: 'a', active: true },
    { name: 'b', active: false },
    { name: 'c', active: true },
  ];

  it('filters per item instead of dropping the whole loop', () => {
    // The condition used to be evaluated once in the enclosing scope, before
    // the loop bound its variable — so it was falsy and nothing rendered.
    const html = render(
      '<Stack><Text each={items} as="it" if={it.active}>[{it.name}]</Text></Stack>',
      context({ state: { items } })
    );
    expect(html).toContain('[a]');
    expect(html).toContain('[c]');
    expect(html).not.toContain('[b]');
  });

  it('leaves a loop without a condition alone', () => {
    const html = render(
      '<Stack><Text each={items} as="it">[{it.name}]</Text></Stack>',
      context({ state: { items } })
    );
    expect(html).toContain('[a]');
    expect(html).toContain('[b]');
    expect(html).toContain('[c]');
  });

  it('leaves a condition without a loop alone', () => {
    const shown = render('<Text if={ok}>yes</Text>', context({ state: { ok: true } }));
    const hidden = render('<Text if={ok}>yes</Text>', context({ state: { ok: false } }));
    expect(shown).toContain('yes');
    expect(hidden).not.toContain('yes');
  });
});

describe('handler props', () => {
  it('does not call an on* prop written as a call during render', () => {
    // `onClick={bump()}` names what to call on click, the same reading
    // `@click={bump()}` already had. Evaluating it during render ran the
    // handler on every render and passed its return value as the callback.
    let calls = 0;
    render(
      '<Button onClick={bump()}>x</Button>',
      context({ functions: { bump: () => { calls++; return 'ret'; } } })
    );
    expect(calls).toBe(0);
  });

  it('does not call an event handler written as a call during render', () => {
    let calls = 0;
    render(
      '<Button @click={bump()}>x</Button>',
      context({ functions: { bump: () => { calls++; return 'ret'; } } })
    );
    expect(calls).toBe(0);
  });
});
