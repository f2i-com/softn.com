// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Engine, zippProfile } from '../wasm-zipp/zipp_wasm.js';
import source from '../wasm-zipp/SOURCE.json';
import { ZippWasmAdapter } from '../src/runtime/zipp-wasm-adapter';

describe('vendored JavaScript and Python engine', () => {
  it('matches the recorded artifact version, languages and checksum', () => {
    const profile = JSON.parse(zippProfile());
    expect(profile.version).toBe(source.version);
    expect(profile.languages).toEqual(['javascript', 'python']);
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
