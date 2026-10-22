/**
 * What a page writes as text or a number in a prop a component declares as a
 * number or a yes-or-no (prop-kinds.ts, the renderer's coerceDeclaredProps).
 *
 * An HTML page writes every attribute as text, and `<Progress value="40">`
 * showed 0: the component asks `Number.isFinite(value)`. A number where a yes
 * or no goes was drawn as text by `{flag && …}` ("Name0" for
 * `<Input label="Name" required={0}>`) and written into ARIA as "1". An audit
 * of the 105 components found 49 number props in 30 of them, and 64 boolean
 * props in 39, that did this; every registration path now gives the renderer
 * what each component declares, generated from the props interfaces.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComponentRegistry, parse, renderDocument, getDefaultRegistry, type SoftNProps, type SoftNRenderContext } from '@softn/core';
import { registerBuiltinComponents, registerAllBuiltins } from '../src/registry';
import { registerRuntimeComponents } from '../src/entries/lazy';
import { registerMinimalComponents } from '../src/entries/minimal';
import { builtinPropKinds } from '../src/prop-kinds';

const context = { state: { none: 0, one: 1 }, setState: () => {}, data: {}, props: {}, computed: {}, functions: {}, asyncFunctions: {} } as unknown as SoftNRenderContext;

function drawn(source: string, registry: ComponentRegistry): string {
  const doc = parse(source);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  return renderToStaticMarkup(<>{renderDocument(doc, context, registry)}</>);
}

const registered = (register: (registry: ComponentRegistry) => void): ComponentRegistry => {
  const registry = new ComponentRegistry();
  register(registry);
  return registry;
};

describe('a number written as text, in a number prop', () => {
  it.each([
    ['registerBuiltinComponents', registered(registerBuiltinComponents)],
    ['registerRuntimeComponents', registered(registerRuntimeComponents)],
    ['registerMinimalComponents', registered(registerMinimalComponents)],
  ])('is the number, through %s', async (_name, registry) => {
    // Through the runtime's registration both are on demand (the display and
    // controls groups): loaded first, as a page's first draw waits for them.
    await registry.preload(['Progress', 'Rating']);
    expect(drawn('<Progress value="40" />', registry)).toContain('aria-valuenow="40"');
    expect((drawn('<Rating max="7" />', registry).match(/role="radio"/g) ?? []).length).toBe(7);
  });

  it('is the number through registerAllBuiltins, in the default registry', () => {
    registerAllBuiltins();
    expect(drawn('<Progress value="40" />', getDefaultRegistry())).toContain('aria-valuenow="40"');
  });
});

describe('a number in a yes-or-no prop', () => {
  const registry = registered(registerBuiltinComponents);

  it('is that yes or no, drawn as no text and written as true or false', () => {
    const input = drawn('<Input label="Name" required={none} />', registry);
    expect(input).not.toContain('Name0');
    expect(input).not.toMatch(/>0</);
    expect(drawn('<Switch checked={one} />', registry)).toContain('aria-checked="true"');
    expect(drawn('<Switch checked={none} />', registry)).toContain('aria-checked="false"');
  });
});

describe('the rule', () => {
  function seen(source: string): SoftNProps {
    let props: SoftNProps = {};
    const registry = new ComponentRegistry();
    registry.register('Probe', (given: SoftNProps) => {
      props = given;
      return null;
    });
    registry.setPropKinds({ Probe: { numbers: ['n'], choices: { level: [2, 3, 4] }, booleans: ['b'] } });
    drawn(source, registry);
    return props;
  }

  it('takes text that writes a finite number, and leaves any other as written', () => {
    expect(seen('<Probe n="40" />').n).toBe(40);
    expect(seen('<Probe n=" 2.5 " />').n).toBe(2.5);
    expect(seen('<Probe n="1e3" />').n).toBe(1000);
    for (const written of ['', 'abc', '100%', '10px', 'Infinity']) expect(seen(`<Probe n="${written}" />`).n).toBe(written);
  });

  it('takes a choice only when it is one of the numbers listed', () => {
    expect(seen('<Probe level="3" />').level).toBe(3);
    expect(seen('<Probe level="9" />').level).toBe('9');
  });

  it('takes only a number as a yes or no: text is left as written', () => {
    expect(seen('<Probe b={0} />').b).toBe(false);
    expect(seen('<Probe b={2} />').b).toBe(true);
    expect(seen('<Probe b="false" />').b).toBe('false');
  });

  it('is not a component of a host’s own by a built-in’s name', () => {
    const registry = registered(registerBuiltinComponents);
    let given: SoftNProps = {};
    registry.register('Progress', (props: SoftNProps) => {
      given = props;
      return null;
    });
    drawn('<Progress value="40" />', registry);
    expect(given.value).toBe('40');
  });

  it('covers every built-in that declares a number or a yes-or-no', () => {
    const kinds = builtinPropKinds();
    expect(kinds.Progress.numbers).toContain('value');
    expect(kinds.Switch.booleans).toContain('checked');
    expect(kinds.Accordion.choices?.headingLevel).toEqual([2, 3, 4, 5, 6]);
    expect(Object.keys(kinds).length).toBeGreaterThan(80);
  });
});
