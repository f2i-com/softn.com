/**
 * `crypto.subtle` in a web container.
 *
 * The engine has none: an app that hashed a password, signed a request, made a PKCE challenge
 * or kept a message secret could not, and a library that finds no `crypto.subtle` either
 * stops or falls back to something weaker (an OAuth client sends its verifier in the clear).
 * Each call is now the browser's own Web Crypto, in the app's Worker, where its keys are kept.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer } from '../src/index';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINES = path.join(PKG_ROOT, 'dist', 'runtime', 'engines');
const ENGINE_FILES = {
  lite: path.join(ENGINES, 'zipp-javascript-lite.wasm'),
  typescript: path.join(ENGINES, 'zipp-typescript.wasm'),
};

/** Runs `body` (an async function's body, in the app) and answers with what it returned, as JSON. */
async function run(body: string) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const said: string[] = [];
  const handle = await mountSoftNContainer(host, {
    isolation: 'inline',
    engineWasm: ENGINE_FILES,
    permissionMode: 'deny',
    onConsole: (level, text) => said.push(`${level}: ${text}`),
    onError: (error) => said.push(`failed: ${error.message}`),
    source: {
      'index.html': `<!doctype html><html><body><p id="out">waiting</p><script type="module">
        const hex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
        const text = (s) => new TextEncoder().encode(s);
        (async () => { ${body} })().then(
          (value) => { document.getElementById('out').textContent = JSON.stringify(value); },
          (e) => { document.getElementById('out').textContent = 'failed: ' + (e && e.name) + ': ' + (e && e.message); }
        );
      </script></body></html>`,
    },
  });
  const out = () => handle.shadowRoot.querySelector('#out')?.textContent ?? '';
  await expect.poll(out, { timeout: 20_000 }).toMatch(/^(\{|failed)/);
  const answer = out();
  handle.dispose();
  if (answer.startsWith('failed')) throw new Error(`${answer}\n${said.join('\n')}`);
  return JSON.parse(answer) as Record<string, unknown>;
}

describe('crypto.subtle in a web container', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('refuses a key past what one may hold, bits past what are derived at once, and a copy of a key it cannot make (where it lost the key without a word)', async () => {
    const answer = await run(`
      const refused = async (work) => { try { await work(); return 'made'; } catch (e) { return e.name + ': ' + e.message; } };
      const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const stored = await new Promise((resolve) => {
        const opening = indexedDB.open('keys', 1);
        opening.onupgradeneeded = () => opening.result.createObjectStore('k');
        opening.onsuccess = () => {
          try { opening.result.transaction('k', 'readwrite').objectStore('k').put(key, 'mine'); resolve('kept'); } catch (e) { resolve(e.name); }
        };
      });
      return {
        huge: await refused(() => crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 8 * 24 * 1024 * 1024 }, false, ['sign'])),
        bits: await refused(async () => {
          const base = await crypto.subtle.importKey('raw', text('secret'), 'HKDF', false, ['deriveBits']);
          return crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: text('s'), info: text('i') }, base, 64 * 1024 * 1024);
        }),
        stored,
        cloned: await refused(async () => structuredClone(key)),
        // A blob is copied as a blob (the document's own copy made a plain object of nothing).
        blob: await (async () => { const copy = structuredClone({ b: new Blob(['abc'], { type: 'text/plain' }) }).b; return [copy instanceof Blob, copy.type, await copy.text()].join('|'); })(),
      };`);
    expect(answer).toEqual({
      huge: 'QuotaExceededError: A key here holds at most 1 MB.',
      bits: expect.stringContaining('OperationError: At most 8388608 bits'),
      stored: 'DataCloneError',
      cloned: expect.stringContaining('DataCloneError'),
      blob: 'true|text/plain|abc',
    });
  });

  it('reads a length of bits as the browser does (a negative one is no way past the cap), derives with none, and hands back an answer of two megabytes and more', async () => {
    const answer = await run(`
      const refused = async (work) => { try { await work(); return 'made'; } catch (e) { return e.name; } };
      const base = await crypto.subtle.importKey('raw', text('secret'), 'PBKDF2', false, ['deriveBits']);
      const a = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      const b = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']);
      const big = new Uint8Array(2200000);
      const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, key, big);
      return {
        negative: await refused(() => crypto.subtle.deriveBits({ name: 'PBKDF2', salt: text('s'), iterations: 1, hash: 'SHA-256' }, base, -8)),
        whole: (await crypto.subtle.deriveBits({ name: 'ECDH', public: b.publicKey }, a.privateKey)).byteLength,
        sealed: sealed.byteLength,
      };`);
    expect(answer).toEqual({ negative: 'OperationError', whole: 32, sealed: 2200016 });
  }, 60_000);

  it('copies with structuredClone as a browser does: two views share their buffer, a blob in an error’s cause is a blob, a key named __proto__ is a key', async () => {
    const answer = await run(`
      const buffer = new ArrayBuffer(8);
      const copy = structuredClone({
        a: new Uint8Array(buffer),
        b: new Uint8Array(buffer, 4),
        e: new Error('failed', { cause: { blob: new Blob(['hi']) } }),
        p: JSON.parse('{"__proto__": 1}'),
      });
      return {
        shared: copy.a.buffer === copy.b.buffer,
        cause: copy.e.cause.blob instanceof Blob,
        proto: Object.prototype.hasOwnProperty.call(copy.p, '__proto__') && Object.getPrototypeOf(copy.p) === Object.prototype,
      };`);
    expect(answer).toEqual({ shared: true, cause: true, proto: true });
  });

  it('is there, and hashes', async () => {
    const answer = await run(`
      return {
        is: crypto.subtle instanceof SubtleCrypto,
        tag: Object.prototype.toString.call(crypto.subtle),
        sha256: hex(await crypto.subtle.digest('SHA-256', text('abc'))),
        sha1: hex(await crypto.subtle.digest({ name: 'SHA-1' }, text('abc').buffer)),
        // A view of part of a buffer is that part.
        part: hex(await crypto.subtle.digest('SHA-256', new Uint8Array(text('xxabcxx').buffer, 2, 3))),
        random: crypto.getRandomValues(new Uint8Array(4)).length + ' ' + typeof crypto.randomUUID(),
      };`);
    expect(answer).toEqual({
      is: true,
      tag: '[object SubtleCrypto]',
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      sha1: 'a9993e364706816aba3e25717850c26c9cd0d89d',
      part: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      random: '4 string',
    });
  });

  it('keeps a secret, and keeps a key the app may not read from it', async () => {
    const answer = await run(`
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, text('a secret'));
      const opened = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, sealed));
      let exported;
      try { await crypto.subtle.exportKey('raw', key); exported = 'exported'; } catch (e) { exported = e.name; }
      let tampered;
      try { await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, new Uint8Array(sealed).map((b, i) => (i === 0 ? b ^ 1 : b))); tampered = 'opened'; } catch (e) { tampered = e.name; }
      return {
        key: [key instanceof CryptoKey, Object.prototype.toString.call(key), key.type, key.extractable, key.algorithm.name, key.algorithm.length, key.usages.join()],
        sealed: sealed instanceof ArrayBuffer && sealed.byteLength,
        opened, exported, tampered,
      };`);
    expect(answer).toEqual({
      key: [true, '[object CryptoKey]', 'secret', false, 'AES-GCM', 256, 'encrypt,decrypt'],
      sealed: 24,
      opened: 'a secret',
      exported: 'InvalidAccessError',
      tampered: 'OperationError',
    });
  });

  it('signs and checks, with a pair of keys, a key read from JSON, and one made from a password', async () => {
    const answer = await run(`
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, text('signed'));
      const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
      const again = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
      const checks = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, again, signature, text('signed'));
      const forged = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, again, signature, text('changed'));
      const hmac = await crypto.subtle.importKey('raw', text('key'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const mac = hex(await crypto.subtle.sign('HMAC', hmac, text('The quick brown fox jumps over the lazy dog')));
      const password = await crypto.subtle.importKey('raw', text('password'), 'PBKDF2', false, ['deriveBits', 'deriveKey']);
      const bits = hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: text('salt'), iterations: 1, hash: 'SHA-1' }, password, 160));
      const derived = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: text('salt'), iterations: 1000, hash: 'SHA-256' }, password, { name: 'AES-KW', length: 128 }, false, ['wrapKey', 'unwrapKey']);
      const inner = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, true, ['encrypt']);
      const wrapped = await crypto.subtle.wrapKey('raw', inner, derived, 'AES-KW');
      const unwrapped = await crypto.subtle.unwrapKey('raw', wrapped, derived, 'AES-KW', 'AES-GCM', true, ['encrypt']);
      const same = hex(await crypto.subtle.exportKey('raw', inner)) === hex(await crypto.subtle.exportKey('raw', unwrapped));
      return {
        pair: [pair.publicKey.type, pair.privateKey.type, pair.publicKey.algorithm.namedCurve],
        jwk: [jwk.kty, jwk.crv, typeof jwk.x],
        checks, forged, mac, bits, wrapped: wrapped.byteLength, same,
      };`);
    expect(answer).toEqual({
      pair: ['public', 'private', 'P-256'],
      jwk: ['EC', 'P-256', 'string'],
      checks: true,
      forged: false,
      mac: 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
      bits: '0c60c80f961f0e71f3a9b524af6012062fe037a6',
      wrapped: 24,
      same: true,
    });
  });

  it('tells an RSA key’s exponent as bytes, and says why what it cannot do fails', async () => {
    const answer = await run(`
      const pair = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['encrypt', 'decrypt']);
      const exponent = pair.publicKey.algorithm.publicExponent;
      let unknown;
      try { await crypto.subtle.digest('SHA-3000', text('x')); unknown = 'hashed'; } catch (e) { unknown = e.name; }
      let notAKey;
      try { await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, { type: 'secret' }, text('x')); notAKey = 'sealed'; } catch (e) { notAKey = e.name; }
      return { exponent: [exponent instanceof Uint8Array, Array.from(exponent).join()], hash: pair.publicKey.algorithm.hash.name, unknown, notAKey };`);
    expect(answer).toEqual({ exponent: [true, '1,0,1'], hash: 'SHA-256', unknown: 'NotSupportedError', notAKey: 'TypeError' });
  });
});
