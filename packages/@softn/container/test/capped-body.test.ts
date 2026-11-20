/**
 * A response's body read with a cap (capped-body.ts): the size an answer says is not always
 * there, nor true, and an answer read whole first was held in memory however large.
 */
import { describe, expect, it } from 'vitest';
import { blobWithin } from '../src/capped-body';

const streamOf = (sizes: number[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const size of sizes) controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  });

describe('a body read with a cap', () => {
  it('reads one within it, and gives up past it whether its size was said or not', async () => {
    expect((await blobWithin(new Response(streamOf([10, 20])), 64)).size).toBe(30);
    await expect(blobWithin(new Response(streamOf([40, 40])), 64)).rejects.toThrow('too large');
    await expect(blobWithin(new Response('x'.repeat(10), { headers: { 'content-length': '100000' } }), 64)).rejects.toThrow('too large');
  });

  it('gives up when what is counted across reads says so', async () => {
    let total = 0;
    await expect(blobWithin(new Response(streamOf([30, 30, 30])), 1000, (bytes) => (total += bytes) <= 50)).rejects.toThrow('too large');
    expect(total).toBe(60);
  });
});