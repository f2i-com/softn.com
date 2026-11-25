/**
 * `softn.wasm.*`: WebAssembly modules an app ships, run in workers of their
 * own (wasm/wasm-host.ts, a chunk fetched at an app's first call).
 *
 * A module is computation: it reaches nothing but what SoftN gives it (see
 * wasm/wasm-worker.ts), so running one from the app's own files, or from
 * bytes its logic holds, needs no permission, as `softn.sandbox.run` needs
 * none. A module fetched from an address is egress like any other: the
 * app's `net` declaration must reach that address.
 *
 * Every answer is `{ value }`, `{ handle, … }` or `{ error }`, never a bare
 * value: a module's JSON may well have an `error` key of its own, and an app
 * must be able to tell that answer from a failed call.
 */

import type { PendingHostCall } from '../script-runtime-types';
import type { WasmArg, WasmFile, WasmHost, WasmReturns } from '../wasm/wasm-host';
import type { HostGate } from './permissions';

/** The largest module, as the host's limit (64 MB): checked before a file is read whole. */
const MAX_MODULE_BYTES = 64 << 20;
/** Maximum cumulative size and count of WASI virtual files supplied to a module. */
const MAX_WASI_FILES = 256;
const MAX_WASI_TOTAL_BYTES = 64 << 20;
/** How long a module's download may take. */
const FETCH_TIMEOUT_MS = 60_000;
const WASM_ENCODER = new TextEncoder();
const WASM_FATAL_DECODER = new TextDecoder('utf-8', { fatal: true });

const RETURNS: readonly WasmReturns[] = ['number', 'text', 'json', 'bytes', 'cstring', 'none'];
const NUMBER_KINDS = ['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'f32', 'f64'] as const;

type Source = { bundle: string } | { url: string } | { bytes: Uint8Array; name: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string, maxBytes = MAX_MODULE_BYTES): Uint8Array {
  const cleaned = text.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (cleaned.length > Math.ceil((maxBytes * 4) / 3) + 4) {
    throw new Error(`Base64 payload exceeds maximum size (${Math.round(maxBytes / (1024 * 1024))} MB)`);
  }
  let binary: string;
  try {
    binary = atob(cleaned);
  } catch {
    throw new Error('A base64 value is not valid base64');
  }
  if (binary.length > maxBytes) {
    throw new Error(`Base64 payload exceeds maximum size (${Math.round(maxBytes / (1024 * 1024))} MB)`);
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function parseJson(text: string | undefined, what: string): unknown {
  if (text === undefined || text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`The ${what} are not JSON`);
  }
}

function objectOf(text: string | undefined, what: string): Record<string, unknown> {
  const value = parseJson(text, what);
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The last part of a path or an address, for messages: `physics.wasm`. */
function baseName(path: string): string {
  const clean = path.replace(/[?#].*$/, '');
  return clean.slice(clean.lastIndexOf('/') + 1) || 'module.wasm';
}

function validateBundleSourcePath(raw: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error('Module path contains invalid control characters');
  }
  const clean = raw.trim().replace(/^\.\//, '');
  if (!clean || clean.startsWith('/') || clean.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//')) {
    throw new Error(`"${raw}" is not a valid bundle path`);
  }
  for (const seg of clean.split('/')) {
    if (!seg || seg === '.' || seg === '..') {
      throw new Error(`"${raw}" is not a valid bundle path`);
    }
  }
  return clean;
}

/**
 * Where a module comes from, as the app wrote it: a path in its bundle
 * (`"assets/physics.wasm"`), an address (`"https://…"`, which needs `net`), a
 * `data:` URL, or `{ bundle }`, `{ url }`, `{ base64, name? }`.
 */
function sourceOf(written: string): Source {
  const raw = String(written ?? '');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error('Module source contains invalid control characters');
  }
  const text = raw.trim();
  if (text.startsWith('{')) {
    const spec = parseJson(text, 'module source');
    if (isRecord(spec)) {
      if (typeof spec.bundle === 'string') return { bundle: validateBundleSourcePath(spec.bundle) };
      if (typeof spec.url === 'string') {
        const u = spec.url.trim();
        // eslint-disable-next-line no-control-regex
        if (/[\u0000-\u001f\u007f]/.test(u) || !/^https?:/i.test(u)) {
          throw new Error(`A module URL must use http: or https:`);
        }
        return { url: u };
      }
      if (typeof spec.base64 === 'string') return { bytes: fromBase64(spec.base64), name: typeof spec.name === 'string' ? spec.name : 'module.wasm' };
    }
    throw new Error('A module source object names { bundle }, { url } or { base64 }');
  }
  if (text === '') throw new Error('No module was named: give a path in the app, such as "assets/module.wasm"');
  if (/^data:/i.test(text)) {
    if (!/^data:[^,]*;base64,/i.test(text)) throw new Error('A data: URL module must be base64 (data:application/wasm;base64,…)');
    return { bytes: fromBase64(text), name: 'module.wasm' };
  }
  if (/^https?:/i.test(text) || text.startsWith('//')) return { url: text.startsWith('//') ? `https:${text}` : text };
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) throw new Error(`A module is read from the app's files, an https address or a data: URL, not "${text.split(':')[0]}:"`);
  return { bundle: validateBundleSourcePath(text) };
}

/** The args a call gives, as the host takes them: numbers as they are, text and bytes to be copied in. */
function argsOf(value: unknown): WasmArg[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((arg, i): WasmArg => {
    if (typeof arg === 'number') return arg;
    if (typeof arg === 'boolean') return arg ? 1 : 0;
    if (arg === null) return null;
    if (typeof arg === 'string') return { text: arg };
    if (isRecord(arg)) {
      // NaN and the infinities, which JSON cannot carry: the preamble writes them so. A float
      // parameter takes them; an integer one refuses them (wasm-worker.ts coerce).
      if (typeof arg.nonFinite === 'string' && Object.keys(arg).length === 1) {
        if (arg.nonFinite === 'NaN') return NaN;
        if (arg.nonFinite === 'Infinity') return Infinity;
        if (arg.nonFinite === '-Infinity') return -Infinity;
        throw new Error(`Argument ${i + 1} is { nonFinite: "${arg.nonFinite}" }: NaN, Infinity or -Infinity`);
      }
      if (typeof arg.base64 === 'string') return { bytes: fromBase64(arg.base64) };
      if (typeof arg.i64 === 'string' || typeof arg.i64 === 'number') {
        try {
          return BigInt(arg.i64);
        } catch {
          throw new Error(`Argument ${i + 1}'s i64 "${String(arg.i64)}" is not a whole number`);
        }
      }
      if (typeof arg.text === 'string' && Object.keys(arg).length === 1) return { text: arg.text };
    }
    // Any other object or list is given as its JSON.
    return { text: JSON.stringify(arg) };
  });
}

/** What can cross back to the app's logic: bytes as base64. */
function forLogic(value: unknown): unknown {
  if (value instanceof Uint8Array) return toBase64(value);
  return value === undefined ? null : value;
}

function numberOption(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function stringList(value: unknown, what: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${what} is a list of texts`);
  return value.map((v) => String(v));
}

function envOf(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new Error('env is an object of names and values');
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key.includes('=') || key === '') throw new Error(`"${key}" cannot be the name of an environment variable`);
    out[key] = String(v);
  }
  return out;
}

/** Text, `{ base64 }` or `{ text }`: bytes. */
function bytesOfValue(value: unknown, what: string, maxBytes = MAX_MODULE_BYTES): Uint8Array {
  if (typeof value === 'string') {
    if (value.length > maxBytes) throw new Error(`${what} exceeds maximum allowed size`);
    const enc = WASM_ENCODER.encode(value);
    if (enc.byteLength > maxBytes) throw new Error(`${what} exceeds maximum allowed size`);
    return enc;
  }
  if (isRecord(value) && typeof value.base64 === 'string') return fromBase64(value.base64, maxBytes);
  if (isRecord(value) && typeof value.text === 'string') {
    if (value.text.length > maxBytes) throw new Error(`${what} exceeds maximum allowed size`);
    const enc = WASM_ENCODER.encode(value.text);
    if (enc.byteLength > maxBytes) throw new Error(`${what} exceeds maximum allowed size`);
    return enc;
  }
  throw new Error(`${what} is a text, or { base64 }`);
}

/** A file handed back by a run: text where its bytes are UTF-8, base64 where they are not. */
function fileForLogic(bytes: Uint8Array): { text: string } | { base64: string } {
  try {
    return { text: WASM_FATAL_DECODER.decode(bytes) };
  } catch {
    return { base64: toBase64(bytes) };
  }
}

/**
 * One value of a write: a number, or NaN or an infinity as the preamble marks
 * them (`{ nonFinite }`), which only a float takes. Anything else, null
 * included (what JSON makes of NaN unmarked), is refused, never written as 0.
 */
function valueToWrite(v: unknown, kind: (typeof NUMBER_KINDS)[number]): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const float = kind === 'f32' || kind === 'f64';
  if (float && isRecord(v) && typeof v.nonFinite === 'string' && Object.keys(v).length === 1) {
    if (v.nonFinite === 'NaN') return NaN;
    if (v.nonFinite === 'Infinity') return Infinity;
    if (v.nonFinite === '-Infinity') return -Infinity;
  }
  const shown = isRecord(v) && typeof v.nonFinite === 'string' ? v.nonFinite : JSON.stringify(v) ?? String(v);
  throw new Error(`write: ${shown} is not a number ${kind.startsWith('u') ? 'a' : 'an'} ${kind} can hold`);
}

function writeValues(kind: (typeof NUMBER_KINDS)[number], values: unknown[]): Uint8Array {
  const size = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, f64: 8 }[kind];
  const out = new Uint8Array(values.length * size);
  const dv = new DataView(out.buffer);
  values.forEach((v, i) => {
    const n = valueToWrite(v, kind);
    const at = i * size;
    if (kind === 'u8') dv.setUint8(at, n);
    else if (kind === 'i8') dv.setInt8(at, n);
    else if (kind === 'u16') dv.setUint16(at, n, true);
    else if (kind === 'i16') dv.setInt16(at, n, true);
    else if (kind === 'u32') dv.setUint32(at, n, true);
    else if (kind === 'i32') dv.setInt32(at, n, true);
    else if (kind === 'f32') dv.setFloat32(at, n, true);
    else dv.setFloat64(at, n, true);
  });
  return out;
}

export class AppWasm {
  /** The app's modules, made at its first call (wasm/wasm-host.ts). */
  private host: WasmHost | null = null;
  /** Modules being fetched from an address, stopped when the app closes. */
  private readonly fetches = new Set<AbortController>();

  /**
   * @param readBundleFile One of the app's own files (NetworkHost.readBlob).
   * @param appId The app's identity: its logic reaches only its own `<WasmApp>` programs.
   */
  constructor(
    private readonly gate: HostGate,
    private readonly readBundleFile: (path: string) => Promise<Blob | null>,
    private readonly appId: () => string | undefined
  ) {}

  /** The app's host, made on its first use; asked again after the chunk's import whether the app is still open. */
  private async getHost(): Promise<WasmHost> {
    if (this.host) return this.host;
    const { WasmHost } = await import('../wasm/wasm-host');
    if (this.gate.disposed()) throw new Error('The app has closed');
    this.host ??= new WasmHost({ appId: this.appId() });
    return this.host;
  }

  /** A module source's permission, asked before anything is read: a refusal is the permission bar's to keep or answer. */
  private allowed(source: Source): void {
    if ('url' in source) {
      this.gate.checkPermission('net');
      this.gate.checkNetHost(source.url);
    }
  }

  private async bytesOf(source: Source): Promise<{ bytes: Uint8Array; name: string }> {
    if ('bytes' in source) return source;
    if ('bundle' in source) {
      const path = source.bundle.replace(/^\.\//, '');
      const blob = await this.readBundleFile(path);
      if (!blob) throw new Error(`This app has no file "${path}"`);
      if (blob.size > MAX_MODULE_BYTES) throw new Error(`"${path}" is ${(blob.size / 1048576).toFixed(1)} MB; a module may be at most 64 MB`);
      return { bytes: new Uint8Array(await blob.arrayBuffer()), name: baseName(path) };
    }
    const controller = new AbortController();
    this.fetches.add(controller);
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      // As softn.net.fetch asks it: no redirect (the net declaration was judged for this address,
      // not for one it sends the request on to), no referrer, no cookies.
      let response: Response;
      try {
        response = await fetch(source.url, { signal: controller.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
      } catch (error) {
        if (controller.signal.aborted && !this.gate.disposed()) throw new Error(`${source.url} took longer than ${FETCH_TIMEOUT_MS / 1000} seconds`);
        throw new Error(`${source.url} could not be fetched (a module is not fetched through a redirect): ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!response.ok) throw new Error(`${source.url} answered ${response.status}`);
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_MODULE_BYTES) throw new Error(`${source.url} is larger than the 64 MB a module may be`);
      const reader = response.body?.getReader();
      if (!reader) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > MAX_MODULE_BYTES) {
          throw new Error(`${source.url} is larger than the 64 MB a module may be`);
        }
        return { bytes, name: baseName(new URL(source.url).pathname) };
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_MODULE_BYTES) {
          controller.abort();
          throw new Error(`${source.url} is larger than the 64 MB a module may be`);
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      return { bytes, name: baseName(new URL(source.url).pathname) };
    } finally {
      clearTimeout(timer);
      this.fetches.delete(controller);
    }
  }

  /** The files a call gives a module: `{ path: text | { base64 } | { bundle } }`. */
  private async filesOf(value: unknown): Promise<WasmFile[]> {
    if (value === undefined || value === null) return [];
    if (!isRecord(value)) throw new Error('files is an object of paths and contents');
    const entries = Object.entries(value);
    if (entries.length > MAX_WASI_FILES) {
      throw new Error(`At most ${MAX_WASI_FILES} files may be passed to a WASM module`);
    }
    const files: WasmFile[] = [];
    let totalBytes = 0;
    for (const [path, content] of entries) {
      if (
        !path ||
        path.startsWith('/') ||
        path.includes('\\') ||
        path.includes('\0') ||
        /^[a-zA-Z]:/.test(path) ||
        path.split('/').some((seg) => !seg || seg === '.' || seg === '..')
      ) {
        throw new Error(`"${path}" is not a path inside the module's files`);
      }
      const remaining = MAX_WASI_TOTAL_BYTES - totalBytes;
      if (isRecord(content) && typeof content.bundle === 'string') {
        const bundlePath = validateBundleSourcePath(content.bundle);
        const blob = await this.readBundleFile(bundlePath);
        if (!blob) throw new Error(`This app has no file "${content.bundle}" to give the module as "${path}"`);
        if (blob.size > remaining) {
          throw new Error(`Total files passed to WASM module exceed ${MAX_WASI_TOTAL_BYTES / (1024 * 1024)} MB`);
        }
        const bytes = new Uint8Array(await blob.arrayBuffer());
        totalBytes += bytes.byteLength;
        files.push({ path, bytes });
      } else {
        const bytes = bytesOfValue(content, `The file "${path}"`, remaining);
        totalBytes += bytes.byteLength;
        files.push({ path, bytes });
      }
    }
    return files;
  }

  private failed(kind: string, error: unknown): { error: string } {
    const text = messageOf(error);
    console.warn(`[SoftN] softn.${kind}: ${text}`);
    return { error: text };
  }

  async load(call: PendingHostCall): Promise<unknown> {
    let source: Source;
    try {
      source = sourceOf(call.args[0]);
    } catch (error) {
      return this.failed('wasm.load', error);
    }
    this.allowed(source);
    try {
      const options = objectOf(call.args[1], 'options');
      const { bytes, name } = await this.bytesOf(source);
      const files = await this.filesOf(options.files);
      const host = await this.getHost();
      return await host.load(bytes, {
        name,
        memoryMB: numberOption(options.memory),
        args: stringList(options.args, 'args'),
        env: envOf(options.env),
        files,
        start: options.start === true,
      });
    } catch (error) {
      return this.failed('wasm.load', error);
    }
  }

  async call(call: PendingHostCall): Promise<unknown> {
    try {
      const [handle, name, argsText, optionsText] = call.args;
      const options = objectOf(optionsText, 'options');
      const returns = options.returns === undefined ? 'number' : String(options.returns);
      if (!RETURNS.includes(returns as WasmReturns)) throw new Error(`returns is one of ${RETURNS.join(', ')}; not "${returns}"`);
      const host = await this.getHost();
      const value = await host.call(String(handle ?? ''), String(name ?? ''), argsOf(parseJson(argsText, 'arguments')), {
        returns: returns as WasmReturns,
        free: options.free === true || typeof options.free === 'string' ? (options.free as boolean | string) : false,
        alloc: typeof options.alloc === 'string' ? options.alloc : null,
        timeoutMs: numberOption(options.timeout),
      });
      return { value: forLogic(value) };
    } catch (error) {
      return this.failed('wasm.call', error);
    }
  }

  async run(call: PendingHostCall): Promise<unknown> {
    let source: Source;
    try {
      source = sourceOf(call.args[0]);
    } catch (error) {
      return this.failed('wasm.run', error);
    }
    this.allowed(source);
    try {
      const options = objectOf(call.args[1], 'options');
      const { bytes, name } = await this.bytesOf(source);
      const files = await this.filesOf(options.files);
      const stdin = options.stdin === undefined || options.stdin === null ? null : bytesOfValue(options.stdin, 'stdin');
      const host = await this.getHost();
      const result = await host.run(bytes, {
        name,
        args: stringList(options.args, 'args'),
        env: envOf(options.env),
        stdin,
        files,
        memoryMB: numberOption(options.memory),
        timeoutMs: numberOption(options.timeout),
        entry: typeof options.entry === 'string' ? options.entry : undefined,
      });
      const asBytes = options.output === 'bytes';
      const decode = (b: Uint8Array) => (asBytes ? toBase64(b) : new TextDecoder().decode(b));
      return {
        exitCode: result.exitCode,
        ...(result.error ? { error: result.error } : {}),
        stdout: decode(result.stdout),
        stderr: decode(result.stderr),
        files: Object.fromEntries(result.files.map((f) => [f.path, fileForLogic(f.bytes)])),
        ...(result.truncated ? { truncated: true } : {}),
      };
    } catch (error) {
      return this.failed('wasm.run', error);
    }
  }

  async read(call: PendingHostCall): Promise<unknown> {
    try {
      const [handle, ptr, length, as] = call.args;
      const host = await this.getHost();
      const value = await host.read(String(handle ?? ''), Number(ptr), Number(length), as ? String(as) : 'bytes');
      return { value: forLogic(value) };
    } catch (error) {
      return this.failed('wasm.read', error);
    }
  }

  async write(call: PendingHostCall): Promise<unknown> {
    try {
      const [handle, ptr, dataText] = call.args;
      const data = parseJson(dataText, 'data');
      let bytes: Uint8Array | null = null;
      if (isRecord(data)) {
        const kind = NUMBER_KINDS.find((k) => Array.isArray(data[k]));
        if (kind) bytes = writeValues(kind, data[kind] as unknown[]);
      }
      bytes ??= bytesOfValue(data, 'write: the data');
      const host = await this.getHost();
      return { written: await host.write(String(handle ?? ''), Number(ptr), bytes) };
    } catch (error) {
      return this.failed('wasm.write', error);
    }
  }

  release(call: PendingHostCall): unknown {
    return { released: this.host?.release(String(call.args[0] ?? '')) ?? false };
  }

  releaseAll(): unknown {
    return { released: this.host?.releaseAll() ?? 0 };
  }

  /** Every module and run stopped, every fetch of one cancelled. */
  dispose(): void {
    for (const controller of this.fetches) controller.abort();
    this.fetches.clear();
    this.host?.dispose();
    this.host = null;
  }
}
