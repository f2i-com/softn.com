// @vitest-environment jsdom
/**
 * A failed app says why. The visitor still sees one plain sentence, but the
 * runtime's own reason is behind a details toggle and in the console; before,
 * every failure was the same sentence and the console stayed empty, which is
 * how a Python app running with no logic went unnoticed in real hosts.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@softn/components', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@softn/brand', () => ({ Mark: () => null }));
import { Failure, SingleApp, describeFailure } from '../src/SingleApp';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const element = document.createElement('div');
document.body.append(element);
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.restoreAllMocks();
});

it('shows the reason behind a details toggle, and only a reason worth showing', () => {
  root = createRoot(element);
  act(() => root!.render(<Failure error={new Error('This app uses the Python package torch, and the engine this page loaded does not provide it')} />));
  expect(element.querySelector('h1')?.textContent).toBe('Unable to open this application');
  expect(element.querySelector('details summary')?.textContent).toBe('Technical details');
  expect(element.querySelector('details p')?.textContent).toMatch(/Python package torch/);

  act(() => root!.render(<Failure />));
  expect(element.querySelector('details')).toBeNull();
  expect(describeFailure({})).toBeNull();
  expect(describeFailure('plain text')).toBe('plain text');
});

it('logs a load failure and shows its message, instead of a bare sentence', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  // A configuration that cannot be fetched: the loader rejects with its reason.
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('runtime.config.json could not be fetched'));
  root = createRoot(element);
  await act(async () => {
    root!.render(<SingleApp source={{ url: 'runtime.config.json' } as never} />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(element.querySelector('h1')?.textContent).toBe('Unable to open this application');
  expect(element.querySelector('details p')?.textContent ?? '').not.toBe('');
  expect(logged).toHaveBeenCalledWith('[SoftN] The application could not open:', expect.anything());
});
