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

import { describe, it, expect, vi } from 'vitest';
import {
  createDBNamespace,
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

const GATED = ['net', 'camera', 'mic', 'files', 'qr', 'ai', 'gpu', 'sync'];

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

/**
 * The state the consent bar introduced: the bundle declared what it needs, the
 * app is already rendering, and the user has not answered. Everything the
 * bundle asked for has to be refused until they do — otherwise "show the UI
 * first" would mean "grant everything and ask afterwards", which is strictly
 * worse than the dialog it replaced.
 */
describe('a bundle whose declared capabilities are withheld pending consent', () => {
  const declared: PermissionConfig = {
    permissions: {
      net: { enabled: true },
      camera: { enabled: true },
      mic: { enabled: true },
      files: { enabled: true },
      qr: { enabled: true },
      ai: { enabled: true },
      gpu: { enabled: true },
      sync: { enabled: true },
    },
  } as PermissionConfig;

  const withheld = { app: declared.app, permissions: {}, consentPending: true } as PermissionConfig;

  it('is refused every capability it declared', () => {
    const runtime = makeRuntime(withheld);
    for (const capability of GATED) {
      expect(() => check(runtime, capability)).toThrow(/not permitted/i);
    }
    // The same runtime with the declared config allows all of them, so the
    // refusals above are the withholding and not a broken fixture.
    const granted = makeRuntime(declared);
    for (const capability of GATED) {
      expect(() => check(granted, capability)).not.toThrow();
    }
  });

  it('tells the user they have not allowed it, not the author to declare it', () => {
    const runtime = makeRuntime(withheld);
    expect(() => check(runtime, 'net')).toThrow(/not allowed it/i);
    expect(() => check(runtime, 'net')).toThrow(/Allow/);
    // "add net.enabled to permission.json" is advice about a file that already
    // says exactly that, given to someone who simply has not clicked a button.
    expect(() => check(runtime, 'net')).not.toThrow(/add net\.enabled/i);
    expect(() => check(runtime, 'net')).not.toThrow(/ships no permission\.json/i);
  });
});

/**
 * `db.startSync` replicates the whole of an app's database to WebRTC peers, and
 * it is the one capability path that does not go through checkPermission — it
 * reads the config itself. Its guard was `config?.permissions && !sync?.enabled`,
 * which short-circuits to false when there is no config: the bundles the rest
 * of the model trusts least were the ones it let through. GlamourStudio and
 * TexasHoldem both call startSync from `_init()`, so this needed no gesture.
 */
describe('the sync bridge on the db namespace', () => {
  const refusalFor = (config: PermissionConfig | null): string | null => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      createDBNamespace(() => config, 'sync-test').startSync('a-room');
    } catch {
      // XDB is never initialised here, so a call that gets past the guard
      // throws on the way to it. That is the allowed path, not a failure.
    }
    const refusal = spy.mock.calls.length > 0 ? String(spy.mock.calls[0][0]) : null;
    spy.mockRestore();
    return refusal;
  };

  it('refuses a bundle that ships no permission.json', () => {
    expect(refusalFor(null)).toMatch(/not permitted/i);
  });

  it('refuses while consent is pending, and says why', () => {
    const withheld = { permissions: {}, consentPending: true } as PermissionConfig;
    expect(refusalFor(withheld)).toMatch(/not allowed yet/i);
  });

  it('refuses a config that declares everything except sync', () => {
    expect(refusalFor({ permissions: { net: { enabled: true } } } as PermissionConfig)).toMatch(/not permitted/i);
  });

  it('does not refuse a config that was granted sync', () => {
    expect(refusalFor({ permissions: { sync: { enabled: true } } } as PermissionConfig)).toBeNull();
  });
});

describe('an unrecognised capability', () => {
  it('is refused rather than ignored, with or without a config', () => {
    expect(() => check(makeRuntime(), 'telepathy')).toThrow();
    expect(() => check(makeRuntime({ permissions: {} } as PermissionConfig), 'telepathy')).toThrow(/unknown capability/i);
  });
});
