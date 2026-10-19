/**
 * Logic that will not compile is told to the host through `onError`, as
 * markup that will not parse is. It used to be shown in the error box and
 * told no one, so a host that reports only through `onError` (FormLogic's
 * frame tells its parent this way) never heard of it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let root: Root | null = null;
let container: HTMLElement;

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  container?.remove();
  vi.restoreAllMocks();
});

describe('logic that will not compile', () => {
  it('is reported through onError', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(
        <SoftNRenderer source={'<logic>\nlet n = (\n</logic>\n<p>{n}</p>'} appId="logic-error-reported" scriptExecutionMode="main" onError={onError} />
      );
    });
    for (let i = 0; i < 100 && onError.mock.calls.length === 0; i++) {
      await act(async () => {
        await sleep(20);
      });
    }
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(String(onError.mock.calls[0][0].message)).toMatch(/SyntaxError|Unexpected|expected/i);
  });
});
