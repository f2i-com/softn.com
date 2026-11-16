/**
 * Which engine runs an app, where it comes from and which bindings it runs under.
 *
 * A host that carries ZIPP's JavaScript-and-Python engine already (every SoftN app does) hands
 * it over for the tiers that ask for no more than it does, and keeps no second copy in the
 * container's folder. That only works if the container asks the host for an engine when it
 * needs that tier and not before, and loads the bindings of the engine it was handed rather
 * than those of the tier's usual file.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer, selectEngineTier } from '../src/index';
import { glueFileFor } from '../src/zipp-loader';
import type { ExtractedScript } from '../src/types';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINES = path.join(PKG_ROOT, 'dist', 'runtime', 'engines');
const LITE_WASM = path.join(ENGINES, 'zipp-javascript-lite.wasm');
const PYTHON_WASM = path.join(ENGINES, 'zipp-python-base.wasm');

const page = (script: string, type = '') =>
  `<!DOCTYPE html><html><body><p id="out">…</p><script${type ? ` type="${type}"` : ''}>${script}</script></body></html>`;

const inline = (code: string, language: ExtractedScript['language'] = 'javascript'): ExtractedScript => ({
  id: 1,
  kind: language === 'python' ? 'python' : 'classic',
  language,
  code,
  originPath: 'index.html.inline-1.js',
});

function settle(ms = 40): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('the engine an app runs on', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('is the lite one until a script names something only the full engine answers rightly', () => {
    expect(selectEngineTier([inline('document.title = "x";')], {})).toBe('lite');
    // Lite has no Intl or Temporal, and its locale methods answer as the plain ones do.
    for (const code of [
      'new Intl.NumberFormat("en-US").format(1)',
      'Temporal.Now.plainDateISO()',
      'price.toLocaleString("en-US", { style: "currency", currency: "USD" })',
      'when.toLocaleDateString()',
      'when.toLocaleTimeString()',
      'names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))',
      'title.toLocaleUpperCase("tr")',
      'title.toLocaleLowerCase("tr")',
    ]) {
      expect(selectEngineTier([inline(code)], {}), code).toBe('javascript');
    }
  });

  it('holds a module the page imports to the same test as a script in the page', () => {
    // A file was held only to `Intl` and `Temporal`: a module that formatted a price with
    // toLocaleString ran on lite and printed it unformatted.
    const entry = inline('import { price } from "./format.js"; document.title = price(1234.5);');
    expect(selectEngineTier([entry], { 'format.js': 'export const price = (n) => n.toLocaleString("en-US");' })).toBe('javascript');
    expect(selectEngineTier([entry], { 'format.js': 'export const price = (n) => String(n);' })).toBe('lite');
    expect(selectEngineTier([entry], { 'format.js': 'export const price = (n) => String(n);', 'types.ts': 'export type N = number;' })).toBe('typescript');
    expect(selectEngineTier([entry], { 'tool.py': 'x = 1' })).toBe('python');
  });

  it('runs under the bindings of the engine that was handed over, whatever tier asked for it', () => {
    // Each engine says what it is; its bindings are that variant's file.
    expect(glueFileFor('lite', { variant: 'lite' })).toBe('zipp-javascript-lite.glue.js');
    expect(glueFileFor('typescript', { variant: 'javascript-typescript' })).toBe('zipp-typescript.glue.js');
    expect(glueFileFor('python', { variant: 'javascript-python-base' })).toBe('zipp-python-base.glue.js');
    // The JavaScript-and-Python engine standing in for the `javascript` tier needs its own
    // bindings: it imports what the JavaScript-only ones do not provide.
    expect(glueFileFor('javascript', { variant: 'javascript-python-base' })).toBe('zipp-python-base.glue.js');
    // An engine that does not say runs under the tier's.
    expect(glueFileFor('javascript', null)).toBe('zipp-javascript.glue.js');
    expect(glueFileFor('python-torch', { variant: 'something-new' })).toBe('zipp-python-base.glue.js');
  });

  it('asks the host for a tier’s engine only when an app needs that tier', async () => {
    const asked: string[] = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      engineWasm: {
        lite: () => {
          asked.push('lite');
          return LITE_WASM;
        },
        javascript: () => {
          asked.push('javascript');
          return PYTHON_WASM;
        },
        python: async () => {
          asked.push('python');
          return PYTHON_WASM;
        },
      },
      // Named in two halves, or the page itself would ask for the full engine.
      source: { 'index.html': page('document.getElementById("out").textContent = "formatting: " + (typeof globalThis["In" + "tl"]);') },
    });
    await settle();
    expect(handle.engineTier).toBe('lite');
    expect(asked).toEqual(['lite']);
    expect(handle.shadowRoot.querySelector('#out')?.textContent).toBe('formatting: undefined');
    handle.dispose();
  });

  it('runs the `javascript` tier on the JavaScript-and-Python engine when the host hands that over', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      engineWasm: { javascript: async () => PYTHON_WASM },
      source: { 'index.html': page('document.getElementById("out").textContent = new Intl.NumberFormat("en-US").format(1234567.891);') },
    });
    await settle();
    expect(handle.engineTier).toBe('javascript');
    expect(handle.shadowRoot.querySelector('#out')?.textContent).toBe('1,234,567.891');
    handle.dispose();
  });

  it('runs a Python script written in the page', async () => {
    // Its name in the page (`index.html.inline-1.py`) is not a module's: the engine answered
    // "Python project: no modules" and the app never started.
    const lines: string[] = [];
    const errors: string[] = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      engineWasm: { python: PYTHON_WASM },
      onConsole: (_level, text) => lines.push(text),
      onError: (error) => errors.push(error.message),
      source: { 'index.html': page('print("python says", 6 * 7)', 'text/python') },
    });
    await settle();
    expect(errors).toEqual([]);
    expect(handle.engineTier).toBe('python');
    expect(lines.join('\n')).toContain('python says 42');
    handle.dispose();
  });

  it('runs a Python file the page names, with the project’s other modules beside it', async () => {
    const lines: string[] = [];
    const errors: string[] = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      engineWasm: { python: PYTHON_WASM },
      onConsole: (_level, text) => lines.push(text),
      onError: (error) => errors.push(error.message),
      source: {
        'index.html': '<!DOCTYPE html><html><body><p>plain</p><script type="text/python" src="main.py"></script></body></html>',
        'main.py': 'from helpers import double\nprint("doubled", double(21))\n',
        'helpers.py': 'def double(n):\n    return n * 2\n',
      },
    });
    await settle();
    expect(errors).toEqual([]);
    expect(lines.join('\n')).toContain('doubled 42');
    handle.dispose();
  });
});
