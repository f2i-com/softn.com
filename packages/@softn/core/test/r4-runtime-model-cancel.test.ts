// @vitest-environment node
/**
 * A reply is stopped when the page asks, on every backend.
 *
 * The model's Worker hears `softn.ai.model.cancel` as a message, which is a
 * task of the Worker's event loop. On the CPU and WebAssembly backends a step
 * is computed where it is awaited and resolves at once, so the reply ran from
 * its first token to its last without the loop ever turning: the cancel was
 * read after the reply had ended, and a long reply could not be stopped.
 * Here the cancel is set by a task of the event loop, as the Worker's message
 * would set it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { ZippModelRunner, type RunnerDeps } from '../src/runtime/models/zipp-model-runner';
import { tinyQwen3 } from './helpers/tiny-gguf';
import { modelDeps } from './helpers/zipp-model-deps';

let deps: RunnerDeps;
beforeAll(async () => {
  deps = await modelDeps();
});

const blob = (bytes: Uint8Array) => new Blob([bytes as BlobPart]);

describe('a reply on a backend that computes in place', () => {
  it('hears a cancel that arrives as a task while it is answering', async () => {
    const runner = await ZippModelRunner.open(blob(tinyQwen3().bytes), deps, { backend: 'cpu-js', context: 1024 });
    try {
      // How long the reply is when nothing stops it: long enough to outlast a
      // turn of the loop on any machine (the runner turns every 50 ms).
      const whole = await runner.generate([{ role: 'user', content: 'and on' }], { temperature: 0, maxNewTokens: 400 });
      expect(whole.finishReason).toBe('length');
      expect(whole.generatedTokens).toBe(400);

      let cancel = false;
      setTimeout(() => {
        cancel = true;
      }, 0);
      const stopped = await runner.generate([{ role: 'user', content: 'and on' }], { temperature: 0, maxNewTokens: 400 }, {
        cancelled: () => cancel,
      });
      expect(stopped.finishReason).toBe('cancelled');
      expect(stopped.generatedTokens).toBeLessThan(400);
    } finally {
      runner.dispose();
    }
  }, 60_000);
});
