/**
 * A response's body as a blob, read a part at a time and given up past `max` bytes.
 *
 * The size an answer says it is (`Content-Length`) is not always there, nor what comes: a
 * chunked answer says none, a compressed one says its compressed size. Read whole before its
 * size was looked at, an answer of any size was held in memory first (the embedding page's,
 * for a picture the page fetches). `counted` is told each part's size as it comes, and refuses
 * it (false) for a total kept across reads; the parts it took are its to give back.
 */
const UTF8_ENCODER = new TextEncoder();

export async function blobWithin(response: Response, max: number, counted?: (bytes: number) => boolean): Promise<Blob> {
  const type = response.headers.get('content-type') ?? '';
  if (Number(response.headers.get('content-length')) > max) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error('too large');
  }
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const whole = await response.blob();
    if (whole.size > max || (counted && !counted(whole.size))) throw new Error('too large');
    return whole;
  }
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max || (counted && !counted(value.byteLength))) throw new Error('too large');
      parts.push(value);
    }
  } catch (err) {
    void reader.cancel().catch(() => undefined);
    throw err;
  }
  return new Blob(parts as BlobPart[], { type });
}

/** Read a response body directly as bounded `Uint8Array` bytes without a Blob -> ArrayBuffer double copy. */
export async function bytesWithin(response: Response, max: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > max) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error('too large');
  }
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > max) throw new Error('too large');
    return buf;
  }
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new Error('too large');
      parts.push(value);
    }
  } catch (err) {
    void reader.cancel().catch(() => undefined);
    throw err;
  }
  if (parts.length === 0) return new Uint8Array(0);
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** Read a response body as UTF-8 text bounded to at most `max` bytes (works in browsers and JSDOM). */
export async function textWithin(response: Response, max: number): Promise<string> {
  if (Number(response.headers.get('content-length')) > max) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error('too large');
  }
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text();
    if (UTF8_ENCODER.encode(text).byteLength > max) throw new Error('too large');
    return text;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let out = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new Error('too large');
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } catch (err) {
    void reader.cancel().catch(() => undefined);
    throw err;
  }
  return out;
}
