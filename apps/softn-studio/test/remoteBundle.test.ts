import { describe, expect, it, vi } from 'vitest';
import { MAX_ZIP_INPUT_BYTES } from '@softn/core';
import { readRemoteBundle } from '../src/lib/remoteBundle';

describe('bounded Studio downloads', () => {
  it('refuses a declared oversized bundle before reading any body bytes', async () => {
    const result = new Response(new Uint8Array([80, 75]), { headers: { 'content-length': String(MAX_ZIP_INPUT_BYTES + 1) } });
    const read = vi.spyOn(result.body!, 'getReader');
    const cancel = vi.spyOn(result.body!, 'cancel');
    await expect(readRemoteBundle(result, new AbortController().signal)).rejects.toThrow('smaller than 200 MB');
    expect(read).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([undefined, '2', 'not-a-length'])('cancels an oversized stream even with an untrustworthy length (%s)', async (declared) => {
    const cancel = vi.fn();
    const result = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([80, 75, 3]));
        controller.enqueue(new Uint8Array([4, 0, 0]));
      },
      cancel,
    }), { headers: declared === undefined ? {} : { 'content-length': declared } });
    await expect(readRemoteBundle(result, new AbortController().signal, 5)).rejects.toThrow('smaller than 200 MB');
    expect(cancel).toHaveBeenCalledOnce();
    expect(result.body!.locked).toBe(false);
  });

  it('accepts all bytes up to the cap from a streamed bundle', async () => {
    const result = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([80, 75]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    }), { headers: { 'content-type': 'application/octet-stream' } });
    expect(await readRemoteBundle(result, new AbortController().signal, 4)).toEqual(new Uint8Array([80, 75, 3, 4]));
    expect(result.body!.locked).toBe(false);
  });

  it.each(['text/html; charset=utf-8', 'application/json'])('reports a non-bundle response before buffering it (%s)', async (contentType) => {
    const result = new Response('Not an app', { headers: { 'content-type': contentType } });
    const read = vi.spyOn(result.body!, 'getReader');
    await expect(readRemoteBundle(result, new AbortController().signal)).rejects.toThrow('a page instead of a .softn app');
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects an empty download', async () => {
    await expect(readRemoteBundle(new Response(null), new AbortController().signal)).rejects.toThrow('empty');
    await expect(readRemoteBundle(new Response(new Uint8Array()), new AbortController().signal)).rejects.toThrow('empty');
  });

  it('releases a stalled body reader on abort instead of waiting for more bytes', async () => {
    const cancel = vi.fn();
    const result = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const controller = new AbortController();
    const reading = readRemoteBundle(result, controller.signal);
    controller.abort();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(result.body!.locked).toBe(false);
  });
});
