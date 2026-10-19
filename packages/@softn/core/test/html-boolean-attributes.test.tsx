/**
 * HTML's boolean attributes are on when they are there, whatever they say.
 *
 * `disabled=""`, `hidden="hidden"` and `open=""` all mean yes in HTML. React
 * reads the empty string as no, so `<input disabled="">` was drawn enabled,
 * and an element a page's script hid (`el.hidden = true`, which writes
 * `hidden=""`) stayed on screen.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry } from '../src/renderer';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';
import type { SoftNRenderContext } from '../src/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function html(source: string): string {
  const context = { state: {}, setState: () => {}, data: {}, functions: {}, computed: {} } as unknown as SoftNRenderContext;
  return renderToStaticMarkup(React.createElement(React.Fragment, null, renderDocument(parse(source), context, new ComponentRegistry())));
}

describe('a boolean attribute written with a value', () => {
  it('is on', () => {
    const out = html(
      '<div><input disabled="" /><input required="required" /><p hidden="">h</p><details open=""><summary>s</summary></details><select multiple=""><option selected="">a</option></select></div>'
    );
    expect(out).toMatch(/<input disabled=""/);
    expect(out).toMatch(/<input required=""/);
    expect(out).toMatch(/<p hidden="">/);
    expect(out).toMatch(/<details open="">/);
    expect(out).toMatch(/<select multiple="">/);
  });

});

describe('a boolean a page’s script sets', () => {
  let root: Root | null = null;
  let container: HTMLElement;
  afterEach(async () => {
    if (root) {
      const current = root;
      await act(async () => current.unmount());
      root = null;
    }
    container?.remove();
  });

  it('is drawn', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const source = `<button id="b">Go</button><p id="p">panel</p><input id="i"><details id="d"><summary>s</summary>x</details>
<script>
  document.getElementById('b').addEventListener('click', () => {
    document.getElementById('p').hidden = true;
    document.getElementById('i').disabled = true;
    document.getElementById('d').open = true;
  });
</script>`;
    await act(async () => {
      root = createRoot(container);
      root.render(<SoftNRenderer source={source} appId="booleans" scriptExecutionMode="main" />);
    });
    for (let i = 0; i < 100 && !container.querySelector('#b')?.hasAttribute('data-softn-node'); i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    await act(async () => {
      (container.querySelector('#b') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect((container.querySelector('#p') as HTMLElement).hidden).toBe(true);
    expect((container.querySelector('#i') as HTMLInputElement).disabled).toBe(true);
    expect((container.querySelector('#d') as HTMLDetailsElement).open).toBe(true);
  });
});
