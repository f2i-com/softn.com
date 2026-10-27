/**
 * `null` options cross as `{}`, as no options do. The preamble's
 * `typeof options === "object"` let null through as "null", and each handler
 * then read a field of null: `softn.net.fetch(url, null, cb)` answered
 * "Cannot read properties of null (reading 'timeout')".
 */
import { describe, expect, it } from 'vitest';
import { VmAdapter, VM_BRIDGE_PREAMBLE } from '../src/runtime/vm-adapter';
import { SOFTN_BRIDGE_PREAMBLE } from '../src/runtime/softn-preamble';
import { SnapshotDBBridge } from '../src/runtime/script-worker-bridges';

describe('the softn preamble', () => {
  it('sends null options as {}', async () => {
    const adapter = await VmAdapter.create();
    adapter.registerDBBridge(new SnapshotDBBridge() as never);
    await adapter.initializeScript(
      VM_BRIDGE_PREAMBLE +
        SOFTN_BRIDGE_PREAMBLE +
        `softn.net.fetch("https://a.example/x", null, function(){});
         softn.mic.record(null, function(){});
         softn.audio.play("a.wav", null, function(){});
         softn.files.pickFile(null, function(){});
         softn.ai.gpu.createPipeline(null, function(){});
         softn.net.fetch("https://a.example/y", { timeout: 5 }, function(){});`
    );
    const calls = adapter.drainPendingHostCalls().map((call) => [call.kind, call.args[call.args.length - 1]]);
    adapter.dispose();
    expect(calls).toEqual([
      ['net.fetch', '{}'],
      ['mic.record', '{}'],
      ['audio.play', '{}'],
      ['files.pickFile', '{}'],
      ['ai.gpu.createPipeline', '{}'],
      ['net.fetch', '{"timeout":5}'],
    ]);
  });
});
