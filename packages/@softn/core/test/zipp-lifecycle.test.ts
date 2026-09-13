// @vitest-environment node
import { describe, expect, it } from 'vitest';
import initWasm, { zippInstanceUsage, zippProfile } from '../wasm-zipp/zipp_wasm.js';
import { ZippWasmAdapter } from '../src/runtime/zipp-wasm-adapter';

// Uses the shipped binary via setup-wasm.ts, not a mocked Engine. Memory-page
// capacity and process RSS are high-water measurements, not live allocations.
describe('shipped ZIPP lifecycle through the Softn adapter', () => {
  it('accounts for an initialized engine disposal exactly once', async () => {
    const before = zippInstanceUsage();
    const adapter = await ZippWasmAdapter.create();
    await adapter.initializeScript('var ready = true;');
    adapter.dispose();
    adapter.dispose();
    const after = zippInstanceUsage();
    expect(after.enginesCreated - before.enginesCreated).toBe(1);
    expect(after.enginesDisposed - before.enginesDisposed).toBe(1);
    expect(adapter.initialized).toBe(false);
  });

  for (const dynamic of [false, true]) {
    it(`disposes 200 working engines ${dynamic ? 'with' : 'without'} dynamic eval`, async () => {
      const { memory } = await initWasm();
      const before = zippInstanceUsage();
      const pagesBefore = memory.buffer.byteLength;
      const rssBefore = process.memoryUsage().rss;
      for (let i = 0; i < 200; i++) {
        const adapter = await ZippWasmAdapter.create();
        try {
          await adapter.initializeScript('var n = 0; function tick() { n++; return n; }');
          expect(adapter.callFunction('tick', [])).toBe(1);
          if (dynamic) expect(adapter.evalSync('n + 1')).toBe(2);
        } finally {
          adapter.dispose();
        }
      }
      const after = zippInstanceUsage();
      expect(after.enginesCreated - before.enginesCreated).toBe(200);
      expect(after.enginesDisposed - before.enginesDisposed).toBe(200);
      // B313 removed these disposed-program totals: the Program is owned.
      expect(after).not.toHaveProperty('programBytecodeBytes');
      const retainedBytes = after.retainedFunctionBytes - before.retainedFunctionBytes;
      if (dynamic) expect(retainedBytes).toBeGreaterThan(0);
      else expect(retainedBytes).toBe(0);
      console.info('ZIPP lifecycle measurement', {
        profile: JSON.parse(zippProfile()).version,
        dynamic,
        cycles: 200,
        retainedFunctionBytes: retainedBytes,
        wasmCapacityGrowthBytes: memory.buffer.byteLength - pagesBefore,
        processRssGrowthBytes: process.memoryUsage().rss - rssBefore,
      });
    });
  }
});
