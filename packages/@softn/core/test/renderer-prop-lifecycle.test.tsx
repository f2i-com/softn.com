import { act } from 'react';
import type { MutableRefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';
import { getXDB } from '../src/runtime/xdb';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe('SoftNRenderer changing props', () => {
  it('recomputes external computed definitions and exposes current state through stateRef', async () => {
    const stateRef: MutableRefObject<(() => Record<string, unknown>) | null> = { current: null };
    const computedDefs = {
      double: (state: Record<string, unknown>) => Number(state.count) * 2,
    };

    await act(async () => {
      root.render(
        <SoftNRenderer
          source="<div>{double}</div>"
          initialState={{ count: 1 }}
          computedDefs={computedDefs}
          stateRef={stateRef}
        />
      );
    });

    expect(container.textContent).toBe('2');
    expect(stateRef.current?.()).toMatchObject({ count: 1, double: 2 });

    await act(async () => {
      root.render(
        <SoftNRenderer
          source="<div>{double}</div>"
          initialState={{ count: 4 }}
          computedDefs={computedDefs}
          stateRef={stateRef}
        />
      );
    });
    await settle();

    expect(container.textContent).toBe('8');
    expect(stateRef.current?.()).toMatchObject({ count: 4, double: 8 });

    await act(async () => root.unmount());
  });

  it('recreates the script runtime when the app namespace changes', async () => {
    const source = `<logic>
db.create("runtime_prop_runs", { value: 1 })
</logic>
<div>ready</div>`;

    await act(async () => {
      root.render(<SoftNRenderer source={source} appId="RuntimePropsA" />);
    });

    for (let attempt = 0; attempt < 60; attempt++) {
      if (getXDB('RuntimePropsA').count('runtime_prop_runs') === 1) break;
      await settle(25);
    }
    expect(getXDB('RuntimePropsA').count('runtime_prop_runs')).toBe(1);

    await act(async () => {
      root.render(<SoftNRenderer source={source} appId="RuntimePropsB" />);
    });

    for (let attempt = 0; attempt < 60; attempt++) {
      if (getXDB('RuntimePropsB').count('runtime_prop_runs') === 1) break;
      await settle(25);
    }
    expect(getXDB('RuntimePropsA').count('runtime_prop_runs')).toBe(1);
    expect(getXDB('RuntimePropsB').count('runtime_prop_runs')).toBe(1);

    await act(async () => root.unmount());
  }, 30_000);
});
