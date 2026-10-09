/**
 * Two things a component was handed that it did not ask for.
 *
 * A tag with nothing inside it was given an empty list as its children,
 * where JSX gives none. A component that asks "was I given children?" took
 * the empty list for a yes: `<Avatar name="Ada Lovelace" />` drew its
 * (absent) children in place of the initials, and of the picture, and lost
 * the role and name a screen reader reads; an Alert with only a title kept
 * an empty box and its margin for the message.
 *
 * And `:bind` on the Radio component, which is a group with `options`, was
 * wired as though it were one `<input type="radio">`: it was told whether it
 * was `checked` and never what the value was, so the chosen option was not
 * shown, and choosing one wrote that single radio's own `value`, which a
 * group does not have: `undefined`, over the answer.
 */

import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry, createRenderCache } from '../src/renderer';

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

interface Seen {
  has: boolean;
  children: unknown;
}

function mount(
  source: string,
  state: Record<string, unknown>,
  registry: ComponentRegistry,
  extra: Record<string, unknown> = {}
): { writes: Array<[string, unknown]>; redraw: () => void } {
  const doc = parse(source);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  const writes: Array<[string, unknown]> = [];
  const context = {
    state,
    setState: (path: string, value: unknown) => writes.push([path, value]),
    data: {},
    props: {},
    computed: {},
    functions: {},
    asyncFunctions: {},
    ...extra,
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const draw = () => act(() => root!.render(<>{renderDocument(doc, context as never, registry)}</>));
  draw();
  return { writes, redraw: draw };
}

describe('a tag with nothing inside it', () => {
  function probe(): { registry: ComponentRegistry; seen: Seen[] } {
    const seen: Seen[] = [];
    const registry = new ComponentRegistry();
    registry.register('Probe', (props: { children?: React.ReactNode; fallback?: string }) => {
      seen.push({ has: 'children' in props, children: props.children });
      // What a component with a fallback does.
      return <span>{props.children ? props.children : (props.fallback ?? 'none')}</span>;
    });
    return { registry, seen };
  }

  it('gives a component no children, as JSX gives none', () => {
    const { registry, seen } = probe();
    mount('<Probe fallback="initials" />', {}, registry);
    expect(seen[0].children).toBeUndefined();
    expect(container!.textContent).toBe('initials');
  });

  it('is the same written with a closing tag', () => {
    const { registry, seen } = probe();
    mount('<Probe fallback="initials"></Probe>', {}, registry);
    expect(seen[0].children).toBeUndefined();
    expect(container!.textContent).toBe('initials');
  });

  it('still gives what is inside it when something is', () => {
    const { registry } = probe();
    mount('<Probe fallback="a">text</Probe>\n<Probe fallback="b">{n}</Probe>\n<Probe fallback="c"><i>x</i></Probe>', { n: 7 }, registry);
    expect(Array.from(container!.querySelectorAll('span')).map((s) => s.textContent)).toEqual(['text', '7', 'x']);
  });

  it('counts an expression that is worth nothing as something inside it', () => {
    // `<Probe>{label}</Probe>` has a child whose text is empty: what is
    // written between the tags is there, whatever it comes to.
    const { registry, seen } = probe();
    mount('<Probe fallback="f">{label}</Probe>', { label: null }, registry);
    expect(seen[0].children).not.toBeUndefined();
  });

  it('is the same for a tag whose contents all come to nothing', () => {
    // `<Alert title="Saved">#if (detail) … #end</Alert>` with no detail has
    // nothing inside it either: a condition that does not hold and a list
    // with nothing in it draw nothing, and a list of nothings is still a
    // yes to "was I given children?".
    const { registry, seen } = probe();
    mount(
      '<Probe fallback="a">\n#if (show)\n<i>x</i>\n#end\n</Probe>\n<Probe fallback="b">\n#each (row in rows)\n<i>{row}</i>\n#end\n#if (show)\n<b>y</b>\n#end\n</Probe>',
      { show: false, rows: [] },
      registry
    );
    expect(seen.map((s) => s.children)).toEqual([undefined, undefined]);
    expect(Array.from(container!.querySelectorAll('span')).map((s) => s.textContent)).toEqual(['a', 'b']);
  });

  it('gives what the contents come to once they come to something', () => {
    const { registry } = probe();
    mount('<Probe fallback="a">\n#if (show)\n<i>x</i>\n#end\n</Probe>\n<Probe fallback="b">\n#each (row in rows)\n<i>{row}</i>\n#end\n</Probe>', { show: true, rows: ['r'] }, registry);
    expect(Array.from(container!.querySelectorAll('span')).map((s) => s.textContent)).toEqual(['x', 'r']);
  });

  it('draws an empty plain element as an empty element', () => {
    mount('<div class="spacer"></div>\n<section />', {}, new ComponentRegistry());
    expect(container!.innerHTML).toBe('<div class="spacer"></div><section></section>');
  });

  it('is handed back the same element when nothing changed, with a cache', () => {
    const { registry, seen } = probe();
    const { redraw } = mount('<Probe fallback="initials" />', {}, registry, { renderCache: createRenderCache() });
    redraw();
    redraw();
    expect(seen).toHaveLength(1);
  });
});

describe(':bind on the Radio component', () => {
  /** A group, as the built-in Radio is: options, the chosen value, and a callback given the new one. */
  function group(): { registry: ComponentRegistry; given: Array<Record<string, unknown>> } {
    const given: Array<Record<string, unknown>> = [];
    const registry = new ComponentRegistry();
    registry.register(
      'Radio',
      (props: { options?: Array<{ value: string; label: string }>; value?: string; checked?: boolean; onChange?: (value: string) => void }) => {
        given.push({ ...props });
        return (
          <div role="radiogroup">
            {(props.options ?? []).map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={props.value === option.value}
                onClick={() => props.onChange?.(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        );
      }
    );
    return { registry, given };
  }

  const source = '<Radio :bind={plan} options={[{ value: "solo", label: "Solo" }, { value: "team", label: "Team" }]} />';

  it('is told the value, so the chosen option is shown', () => {
    const { registry, given } = group();
    mount(source, { plan: 'team' }, registry);
    expect(given[0].value).toBe('team');
    expect(given[0]).not.toHaveProperty('checked');
    const checked = Array.from(container!.querySelectorAll('[role="radio"]')).map((el) => el.getAttribute('aria-checked'));
    expect(checked).toEqual(['false', 'true']);
  });

  it('writes the option chosen', () => {
    const { registry } = group();
    const { writes } = mount(source, { plan: 'team' }, registry);
    act(() => {
      container!.querySelectorAll('[role="radio"]')[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(writes).toEqual([['plan', 'solo']]);
  });

  it('shows nothing chosen while the value has not arrived, and still writes', () => {
    const { registry, given } = group();
    const { writes } = mount(source, { plan: null }, registry);
    expect(given[0].value).toBe('');
    act(() => {
      container!.querySelectorAll('[role="radio"]')[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(writes).toEqual([['plan', 'team']]);
  });

  it('leaves a plain radio input as it was: checked when its own value is the bound one', () => {
    const { writes } = mount(
      '<input type="radio" value="a" :bind={choice} />\n<input type="radio" value="b" :bind={choice} />',
      { choice: 'b' },
      new ComponentRegistry()
    );
    const inputs = Array.from(container!.querySelectorAll('input'));
    expect(inputs.map((input) => input.checked)).toEqual([false, true]);
    act(() => {
      inputs[0].click();
    });
    expect(writes).toContainEqual(['choice', 'a']);
  });
});
