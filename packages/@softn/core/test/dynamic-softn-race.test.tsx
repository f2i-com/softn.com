import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDynamicSoftN } from '../src/loader/useDynamicSoftN';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const SOURCE_A = '<div>A</div>';
const SOURCE_B = '<div>B</div>';

function Probe({
  filePath,
  watch = false,
  debounceMs,
}: {
  filePath: string;
  watch?: boolean;
  debounceMs?: number;
}) {
  const { source, loading, error } = useDynamicSoftN({ filePath, watch, debounceMs });
  return (
    <output
      data-source={source ?? ''}
      data-loading={String(loading)}
      data-error={error?.message ?? ''}
    />
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as typeof window & { __TAURI__?: unknown }).__TAURI__;
});

function installReads(reads: Record<string, Deferred<string>>) {
  const invoke = vi.fn((command: string, args?: { path?: string }) => {
    if (command !== 'read_softn_file' || !args?.path || !reads[args.path]) {
      return Promise.reject(new Error(`Unexpected Tauri call: ${command}`));
    }
    return reads[args.path].promise;
  });
  (window as typeof window & { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
  return invoke;
}

interface ChangeEvent {
  payload: { path: string; kind: 'create' | 'modify' | 'remove' };
}

function installWatcher(
  reads: Record<string, Deferred<string>>,
  registrations: Deferred<() => void>[]
) {
  const handlers: Array<(event: ChangeEvent) => void> = [];
  const invoke = vi.fn((command: string, args?: { path?: string; dir?: string }) => {
    if (command === 'read_softn_file' && args?.path && reads[args.path]) {
      return reads[args.path].promise;
    }
    if (command === 'watch_softn_files' || command === 'stop_watching') {
      return Promise.resolve();
    }
    return Promise.reject(new Error(`Unexpected Tauri call: ${command}`));
  });
  const listen = vi.fn((_event: string, handler: (event: ChangeEvent) => void) => {
    handlers.push(handler);
    const registration = registrations[handlers.length - 1];
    if (!registration) return Promise.reject(new Error('Unexpected listener registration'));
    return registration.promise;
  });
  (window as typeof window & { __TAURI__?: unknown }).__TAURI__ = {
    core: { invoke },
    event: { listen },
  };
  return { invoke, listen, handlers };
}

function output(): HTMLOutputElement {
  return container.querySelector('output') as HTMLOutputElement;
}

describe('useDynamicSoftN request ordering', () => {
  it('does not let a slow old path overwrite a faster new path', async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    const invoke = installReads({ A: a, B: b });

    act(() => root.render(<Probe filePath="A" />));
    act(() => root.render(<Probe filePath="B" />));

    await act(async () => {
      b.resolve(SOURCE_B);
      await b.promise;
      await Promise.resolve();
    });
    expect(output().dataset.source).toBe(SOURCE_B);
    expect(output().dataset.loading).toBe('false');

    await act(async () => {
      a.resolve(SOURCE_A);
      await a.promise;
      await Promise.resolve();
    });

    expect(output().dataset.source).toBe(SOURCE_B);
    expect(output().dataset.error).toBe('');
    expect(invoke.mock.calls.map(([, args]) => args?.path)).toEqual(['A', 'B']);
  });

  it('ignores an old path rejection and its finally block while the new path loads', async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    installReads({ A: a, B: b });

    act(() => root.render(<Probe filePath="A" />));
    act(() => root.render(<Probe filePath="B" />));

    await act(async () => {
      a.reject(new Error('A failed'));
      await a.promise.catch(() => undefined);
      await Promise.resolve();
    });

    expect(output().dataset.error).toBe('');
    expect(output().dataset.loading).toBe('true');

    await act(async () => {
      b.resolve(SOURCE_B);
      await b.promise;
      await Promise.resolve();
    });
    expect(output().dataset.source).toBe(SOURCE_B);
    expect(output().dataset.loading).toBe('false');
  });
});

describe('useDynamicSoftN file watching', () => {
  it('releases a listener whose async registration finishes after its effect was replaced', async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    const registrationA = deferred<() => void>();
    const registrationB = deferred<() => void>();
    const unlistenA = vi.fn();
    const unlistenB = vi.fn();
    const { invoke, handlers } = installWatcher({ A: a, B: b }, [registrationA, registrationB]);

    act(() => root.render(<Probe filePath="A" watch debounceMs={0} />));
    await act(async () => {
      a.resolve(SOURCE_A);
      await a.promise;
      await Promise.resolve();
    });

    act(() => root.render(<Probe filePath="B" watch debounceMs={0} />));
    expect(handlers).toHaveLength(2);

    // Even if the old callback is retained by the platform, it is inert after
    // the path effect was disposed and cannot invalidate B's request generation.
    handlers[0]({ payload: { path: 'A', kind: 'modify' } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(
      invoke.mock.calls
        .filter(([command]) => command === 'read_softn_file')
        .map(([, args]) => args?.path)
    ).toEqual(['A', 'B']);

    await act(async () => {
      b.resolve(SOURCE_B);
      await b.promise;
      await Promise.resolve();
    });
    expect(output().dataset.source).toBe(SOURCE_B);

    await act(async () => {
      registrationA.resolve(unlistenA);
      await registrationA.promise;
      await Promise.resolve();
    });
    expect(unlistenA).toHaveBeenCalledOnce();

    await act(async () => {
      registrationB.resolve(unlistenB);
      await registrationB.promise;
      await Promise.resolve();
    });
    expect(unlistenB).not.toHaveBeenCalled();
  });

  it('normalizes a Windows file path before choosing the watched directory', async () => {
    const path = 'C:\\project\\main.ui';
    const read = deferred<string>();
    const registration = deferred<() => void>();
    const { invoke } = installWatcher({ [path]: read }, [registration]);

    act(() => root.render(<Probe filePath={path} watch />));

    expect(invoke.mock.calls.find(([command]) => command === 'watch_softn_files')?.[1]).toEqual({
      dir: 'C:/project',
    });

    await act(async () => {
      read.resolve(SOURCE_A);
      registration.resolve(() => {});
      await Promise.all([read.promise, registration.promise]);
      await Promise.resolve();
    });
  });
});
