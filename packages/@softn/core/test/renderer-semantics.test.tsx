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

describe('computed values in templates', () => {
  // A `$:` declaration is stored as a thunk, because its value has to be
  // re-derived whenever the state it reads moves. The lookup returned the thunk
  // rather than calling it, so a template got the function instead of the value.
  // Nothing errored — the page just printed the compiled source of the closure:
  //   (...r)=>{let i={...t,state:{...t.state}};if(e.para
  it('interpolates the value, not the thunk', () => {
    const html = render(
      '<Text>{total}</Text>',
      context({ computed: { total: () => 42 } as unknown as SoftNRenderContext['computed'] })
    );
    expect(html).toContain('42');
    expect(html).not.toContain('=>');
  });

  it('iterates what a computed returns', () => {
    // The shape that showed it: the demo bundle's `#each (todo in filteredTodos)`
    // rendered the closure's source into the page instead of the list.
    const html = render(
      '#each (n in items)\n  <Text>[{n}]</Text>\n#end',
      context({
        computed: { items: () => ['a', 'b'] } as unknown as SoftNRenderContext['computed'],
      })
    );
    expect(html).toContain('[a]');
    expect(html).toContain('[b]');
    expect(html).not.toContain('=>');
  });

  it('re-reads the computed rather than caching a first answer', () => {
    let n = 0;
    const ctx = context({
      computed: { tick: () => ++n } as unknown as SoftNRenderContext['computed'],
    });
    expect(render('<Text>{tick}</Text>', ctx)).toContain('1');
    expect(render('<Text>{tick}</Text>', ctx)).toContain('2');
  });

  it('still passes a plain non-function computed straight through', () => {
    const html = render(
      '<Text>{label}</Text>',
      context({ computed: { label: 'ready' } as unknown as SoftNRenderContext['computed'] })
    );
    expect(html).toContain('ready');
  });

  it('does not shadow state of the same name', () => {
    // State is consulted first; a computed must not take precedence over it.
    const html = render(
      '<Text>{value}</Text>',
      context({
        state: { value: 'from-state' },
        computed: { value: () => 'from-computed' } as unknown as SoftNRenderContext['computed'],
      })
    );
    expect(html).toContain('from-state');
  });
});

describe('a throwing expression in a structural position', () => {
  // The same bad data should not be survivable in one place and fatal in
  // another. `{JSON.parse(raw).n}` in a text node is caught and shown inline; in
  // a condition or an iterable it escaped the error boundary and replaced the
  // whole app. Commit 8e9366b set out to fix all four and reached one (#if),
  // and said in its message that it had done all four — so nobody looked again.
  const BAD = 'JSON.parse(raw).n';
  const ctx = () => context({ state: { raw: 'not json' } });

  it('does not escape from #if', () => {
    expect(() => render(`#if (${BAD})\n  <Text>yes</Text>\n#end`, ctx())).not.toThrow();
  });

  it('does not escape from #each', () => {
    expect(() => render(`#each (x in ${BAD})\n  <Text>{x}</Text>\n#end`, ctx())).not.toThrow();
  });

  it('does not escape from an inline if=', () => {
    expect(() => render(`<Text if={${BAD}}>hi</Text>`, ctx())).not.toThrow();
  });

  it('does not escape from an inline each=', () => {
    expect(() => render(`<Text each={${BAD}} as="x">{x}</Text>`, ctx())).not.toThrow();
  });

  it('treats an unanswerable condition as false, not true', () => {
    const html = render(`<Text if={${BAD}}>SHOULD-NOT-SHOW</Text>`, ctx());
    expect(html).not.toContain('SHOULD-NOT-SHOW');
  });

  it('treats an unevaluatable iterable as empty, so #empty renders', () => {
    const html = render(
      `#each (x in ${BAD})\n  <Text>{x}</Text>\n#empty\n  <Text>EMPTY-FALLBACK</Text>\n#end`,
      ctx()
    );
    expect(html).toContain('EMPTY-FALLBACK');
  });

  it('still renders normally when the expression is fine', () => {
    const good = context({ state: { raw: '{"n":2}', items: ['a', 'b'] } });
    expect(render('#each (x in items)\n  <Text>[{x}]</Text>\n#end', good)).toContain('[a]');
    expect(render('<Text if={items}>SHOWN</Text>', good)).toContain('SHOWN');
  });
});
