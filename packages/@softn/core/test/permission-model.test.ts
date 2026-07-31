/**
 * The permission model's default answer.
 *
 * A `.softn` is a ZIP the user may have received from anyone, so the question
 * "what may this bundle do when it has not said what it needs?" has exactly one
 * safe answer. It used to be "everything": a bundle with no permission.json got
 * the network, the camera, the filesystem, AI and the GPU with no prompt, while
 * a bundle that honestly declared `net` got a consent dialog the user could
 * refuse. Declaring less bought more, which is the wrong way round for a
 * capability model and the wrong incentive for an author.
 */

import { describe, it, expect } from 'vitest';
import {
  createScriptRuntime,
  createMockXDBModule,
  createMockNavModule,
  createConsoleModule,
  type ScriptContext,
  type PermissionConfig,
} from '../src/runtime/script-runtime';

/**
 * checkPermission and setPermissionConfig are private to TypeScript only; both
 * exist on the object at runtime. Reaching for them keeps these tests on the
 * decision itself rather than on one host call that happens to consult it.
 */
interface RuntimeInternals {
  checkPermission(capability: string): void;
  setPermissionConfig(config: PermissionConfig): void;
}

function check(runtime: unknown, capability: string): void {
  (runtime as unknown as RuntimeInternals).checkPermission(capability);
}

function makeRuntime(config?: PermissionConfig) {
  const context: ScriptContext = {
    state: {},
    setState: () => {},
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
  const runtime = createScriptRuntime(context, undefined, 'permission-test');
  if (config) (runtime as unknown as RuntimeInternals).setPermissionConfig(config);
  return runtime;
}

const GATED = ['net', 'camera', 'files', 'qr', 'ai', 'gpu', 'sync'];

describe('a bundle that ships no permission.json', () => {
  it('is refused every gated capability', () => {
    const runtime = makeRuntime();
    for (const capability of GATED) {
      expect(() => check(runtime, capability)).toThrow(/not permitted/i);
    }
  });

  it('is told what to add rather than just refused', () => {
    const runtime = makeRuntime();
    expect(() => check(runtime, 'net')).toThrow(/permission\.json/i);
  });
});

describe('a bundle that declares what it needs', () => {
  it('gets the capability it asked for', () => {
    const runtime = makeRuntime({ permissions: { net: { enabled: true } } } as PermissionConfig);
    expect(() => check(runtime, 'net')).not.toThrow();
  });

  it('still does not get the ones it did not ask for', () => {
    const runtime = makeRuntime({ permissions: { net: { enabled: true } } } as PermissionConfig);
    for (const capability of GATED.filter((c) => c !== 'net')) {
      expect(() => check(runtime, capability)).toThrow(/not permitted/i);
    }
  });

  it('does not get a capability it declared as disabled', () => {
    const runtime = makeRuntime({ permissions: { camera: { enabled: false } } } as PermissionConfig);
    expect(() => check(runtime, 'camera')).toThrow(/not permitted/i);
  });
});

describe('an unrecognised capability', () => {
  it('is refused rather than ignored, with or without a config', () => {
    expect(() => check(makeRuntime(), 'telepathy')).toThrow();
    expect(() => check(makeRuntime({ permissions: {} } as PermissionConfig), 'telepathy')).toThrow(/unknown capability/i);
  });
});
