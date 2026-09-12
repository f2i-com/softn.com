import { MAX_ZIP_INPUT_BYTES } from '@softn/core';

const TOO_LARGE = `Choose a project file smaller than ${MAX_ZIP_INPUT_BYTES / 1024 / 1024} MB.`;

/** Bound the download itself, before the importer allocates or unzips it. */
export async function readRemoteBundle(
  response: Response,
  signal: AbortSignal,
  maxBytes = MAX_ZIP_INPUT_BYTES,
): Promise<Uint8Array<ArrayBuffer>> {
  const declaredLength = Number(response.headers.get('content-length'));
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (declaredLength > maxBytes || contentType === 'text/html' || contentType === 'application/json') {
    void response.body?.cancel().catch(() => {});
    throw new Error(declaredLength > maxBytes ? TOO_LARGE : 'The link returned a page instead of a .softn app.');
  }
  signal.throwIfAborted();
  if (!response.body) throw new Error('The app download was empty.');

  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) throw new Error(TOO_LARGE);
      chunks.push(next.value);
    }
    if (length === 0) throw new Error('The app download was empty.');
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
