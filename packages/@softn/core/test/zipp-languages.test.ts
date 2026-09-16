// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Engine, zippProfile } from '../wasm-zipp/zipp_wasm.js';
import source from '../wasm-zipp/SOURCE.json';
import { ZippWasmAdapter } from '../src/runtime/zipp-wasm-adapter';
import { zippLanguages } from '../src/runtime/zipp-wasm-loader';

describe('installed JavaScript and Python engine', () => {
  // What a host asks when it has to decide whether a bundle can run at all.
  // The record in SOURCE.json says what was installed; this says what loaded.
  it('tells a host which languages the engine that loaded can run', async () => {
    await expect(zippLanguages()).resolves.toEqual(source.languages);
    await expect(zippLanguages()).resolves.toContain('python');
  });

  it('matches the recorded release version, commit, languages and checksum', () => {
    const profile = JSON.parse(zippProfile());
    expect(profile.version).toBe(source.version);
    expect(source.languages).toContain('python');
    expect(profile.languages).toEqual(source.languages);
    // A release build reports the commit it was built from. A local build
    // (--install-local) reports none, so it fails here by design.
    expect(profile.source.sha).toBe(source.revision);
    expect(profile.features).toContain('safe-sandbox');
    expect(createHash('sha256').update(new Uint8Array(readFileSync('wasm-zipp/zipp_wasm_bg.wasm'))).digest('hex')).toBe(source.sha256);
  });

  it('keeps JavaScript reactive state separate from a Python program in the same WASM', async () => {
    const javascript = await ZippWasmAdapter.create();
    const python = new Engine();
    try {
      await javascript.initializeScript('let count = 0; function next() { count += 1; return count; }');
      python.setInstructionBudget(5_000_000);
      python.initSource('count = 10\ndef next():\n    global count\n    count += 1\n    return count\n', 'python');
      expect(python.pythonHas('next')).toBe(true);
      expect(javascript.callFunction('next', [])).toBe(1);
      expect(python.pythonCall('next', [])).toBe(11);
      expect(javascript.callFunction('next', [])).toBe(2);
      expect(python.pythonCall('next', [])).toBe(12);
    } finally {
      javascript.dispose();
      python.dispose();
      python.free();
    }
  });

  it('runs a multi-file Python calculation and returns structured data', () => {
    const python = new Engine();
    try {
      python.setInstructionBudget(5_000_000);
      python.initPythonProject({
        'main.py': 'from prices import total\ndef quote(items):\n    return {"total": total(items), "count": len(items)}\n',
        'prices.py': 'def total(items):\n    return sum(items)\n',
      }, 'main.py', undefined);
      expect(python.pythonCall('quote', [[12, 7, 5]])).toEqual({ total: 24, count: 3 });
    } finally {
      python.dispose();
      python.free();
    }
  });
});

/**
 * The JavaScript-only web build of the same release, installed beside the
 * engine as a verified variant. Softn never loads it itself; FormLogic may
 * offer it as the `zipp-web` engine, running under the engine's glue — the
 * only glue Softn ships — so that is how it is loaded here: the same
 * `zipp_wasm.js`, a second module record (the query suffix), the variant's
 * bytes.
 */
describe('installed JavaScript-only web variant, under the engine\'s glue', () => {
  const variant = JSON.parse(readFileSync('wasm-zipp-web/SOURCE.json', 'utf8'));
  const webBytes = readFileSync('wasm-zipp-web/zipp_wasm_bg.wasm');
  // Typed by the primary's declarations: the variant exports a subset, so every
  // name is there and the Python ones are the ones that must throw. The
  // specifier is a value, not a literal, so tsc does not try to resolve the
  // query — Vite does, and gives a second module record for it.
  const VARIANT_GLUE = '../wasm-zipp/zipp_wasm.js?variant=web';
  const load = async (): Promise<typeof import('../wasm-zipp/zipp_wasm.js')> => {
    const glue = (await import(VARIANT_GLUE)) as typeof import('../wasm-zipp/zipp_wasm.js');
    glue.initSync({ module: new Uint8Array(webBytes) });
    return glue;
  };

  it('is the variant the engine install records, and another build of the same source', () => {
    const web = (source as { variants?: { web?: Record<string, unknown> } }).variants?.web;
    expect(web).toBeDefined();
    expect(createHash('sha256').update(new Uint8Array(webBytes)).digest('hex')).toBe(web!.sha256);
    expect(variant.sha256).toBe(web!.sha256);
    expect(variant.sha256).not.toBe(source.sha256);
    expect(variant.commit).toBe(source.revision);
    expect(variant.revision).toBe(source.revision);
    expect(variant.release).toBe(source.release);
    expect(variant.languages).toEqual(['javascript']);
    expect(variant.primary).toEqual({ bundle: source.bundle, sha256: source.sha256, glueSha256: source.glueSha256 });
    // Its own glue is recorded and not shipped.
    expect(variant.glueSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(variant.glueSha256).not.toBe(source.glueSha256);
  });

  it('reports exactly JavaScript, from a module record the engine\'s own does not share', async () => {
    const glue = await load();
    expect(glue.zippProfile).not.toBe(zippProfile);
    const profile = JSON.parse(glue.zippProfile());
    expect(profile.languages).toEqual(['javascript']);
    expect(profile.languages).toEqual(variant.languages);
    expect(profile.version).toBe(source.version);
    expect(profile.source.sha).toBe(source.revision);
    expect(profile.features).toContain('safe-sandbox');
    // The engine's own record still answers for the engine.
    expect(JSON.parse(zippProfile()).languages).toEqual(['javascript', 'python']);
  });

  it('refuses every Python entry point, each on a fresh guest', async () => {
    const glue = await load();
    // A guest that failed to start is disposed, so each refusal gets its own
    // Engine: the reason has to be the missing Python, not the earlier failure.
    const refusal = (call: (engine: InstanceType<typeof glue.Engine>) => unknown): string => {
      const engine = new glue.Engine();
      try {
        call(engine);
        return '';
      } catch (error) {
        return String((error as Error).message ?? error);
      } finally {
        try { engine.dispose(); engine.free(); } catch { /* already gone */ }
      }
    };
    expect(refusal((e) => e.initSource('x = 1\n', 'python'))).toMatch(/Python/);
    expect(refusal((e) => e.pythonHas('x'))).toMatch(/engine_pythonHas is not a function/);
    expect(refusal((e) => e.pythonCall('x', []))).toMatch(/engine_pythonCall is not a function/);
    expect(refusal((e) => e.initPythonProject({ 'main.py': 'x = 1\n' }, 'main.py', undefined))).toMatch(/engine_initPythonProject is not a function/);
  });

  it('runs the JavaScript surface the adapter uses', async () => {
    const glue = await load();
    const engine = new glue.Engine();
    try {
      engine.setInstructionBudget(5_000_000);
      engine.initScript('let count = 40; function next() { count += 1; return count; }');
      expect(engine.callFunction('next', [])).toBe(41);
      expect(engine.callFunction('next', [])).toBe(42);
      expect(engine.evalInContext('count * 2')).toBe(84);
    } finally {
      engine.dispose();
      engine.free();
    }
  });
});
