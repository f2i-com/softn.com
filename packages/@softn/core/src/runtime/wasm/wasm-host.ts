/**
 * Running WebAssembly modules for an app: one worker each, started from
 * wasm-worker.ts's source as a `blob:` address, with the limits an app's
 * module runs under.
 *
 * Three ways in:
 *
 * - `load` keeps a module running for an app's logic to call
 *   (`softn.wasm.load` / `softn.wasm.call`, host-calls/wasm.ts): a library,
 *   or a WASI reactor whose functions are called one after another on the
 *   same memory.
 * - `run` runs a WASI command once, start to exit, in a worker of its own,
 *   and hands back its exit code, what it printed and the files it wrote.
 * - `startWasmProgram` runs a program that draws, for the `<WasmApp>`
 *   component: frames, input, sound. A program is also listed in a page-wide
 *   registry under its handle, so its own app's logic can call its functions
 *   the same way (`softn.wasm.call(handle, …)`).
 *
 * The limits: a module's file size; the memory and the table entries it may
 * grow to, written into the module (wasm-binary.ts), and what cannot be held
 * to them refused; how long a call, a run or a frame may take, counted from
 * when the worker is given it, after which the worker is terminated and the
 * module is gone; how many modules, runs and programs an app has at once,
 * those still starting included; how much a run's output and files may hold.
 */

import {
  WASM_PAGE_BYTES,
  WasmFormatError,
  capWasmModule,
  cappedImports,
  checkRunnable,
  moduleKind,
  pagesToMB,
  readWasmModule,
  type WasmCaps,
  type WasmExport,
  type WasmModuleInfo,
} from './wasm-binary';
import {
  wasmWorkerMain,
  type WasmArg,
  type WasmInputEvent,
  type WasmMode,
  type WasmReturns,
  type WasmStartMessage,
  type WasmWorkerReply,
  type WasmWorkerRequest,
} from './wasm-worker';

export type { WasmArg, WasmInputEvent, WasmReturns } from './wasm-worker';

/** What a module runs in: a Worker, or a stand-in with the same four members. */
export interface WasmWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: string; preventDefault?: () => void }) => void) | null;
}

export type WasmWorkerFactory = () => WasmWorkerLike;

export interface WasmLimits {
  /** The largest module file. */
  maxModuleBytes: number;
  /** The memory a module may grow to when the app does not say. */
  memoryMB: number;
  /** The most an app may ask for. */
  maxMemoryMB: number;
  /** Table entries a module may grow to, every table together. */
  maxTableEntries: number;
  /** Compiling, starting and `_initialize`. */
  loadTimeoutMs: number;
  callTimeoutMs: number;
  maxCallTimeoutMs: number;
  runTimeoutMs: number;
  maxRunTimeoutMs: number;
  /** How long a program's frame may take before it is thought stuck. */
  frameTimeoutMs: number;
  /** Modules an app keeps loaded at once, those starting included. */
  maxModules: number;
  /** Commands an app runs at once. */
  maxRuns: number;
  /** Programs (<WasmApp>) an app runs at once, those starting included. */
  maxPrograms: number;
  /** Of a run's stdout, and of its stderr. */
  maxOutputBytes: number;
  /** All the files a module holds together. */
  maxFileBytes: number;
}

export const DEFAULT_WASM_LIMITS: Readonly<WasmLimits> = Object.freeze({
  maxModuleBytes: 64 << 20,
  memoryMB: 256,
  maxMemoryMB: 1024,
  maxTableEntries: 1_000_000,
  loadTimeoutMs: 60_000,
  callTimeoutMs: 10_000,
  maxCallTimeoutMs: 120_000,
  runTimeoutMs: 30_000,
  maxRunTimeoutMs: 300_000,
  frameTimeoutMs: 5_000,
  maxModules: 8,
  maxRuns: 4,
  maxPrograms: 8,
  maxOutputBytes: 4 << 20,
  maxFileBytes: 128 << 20,
});

/** A file given to a module: its path in the module's files, and its bytes. */
export interface WasmFile {
  path: string;
  bytes: Uint8Array;
}

export interface WasmLoadOptions {
  /** For messages, and the first argument a WASI module sees. */
  name: string;
  memoryMB?: number;
  args?: string[];
  env?: Record<string, string>;
  files?: WasmFile[];
  /** Run `_start` before any call (a module built as a command). */
  start?: boolean;
  /** Where its printing goes, line by line; the console by default. */
  onConsole?: (stream: 'out' | 'err', text: string) => void;
}

export interface WasmExportInfo {
  name: string;
  kind: string;
  params?: string[];
  results?: string[];
}

export interface WasmLoadResult {
  handle: string;
  name: string;
  kind: 'command' | 'reactor' | 'library';
  exports: WasmExportInfo[];
  /** What it imports that SoftN does not give: each stops the module if it is called. */
  missing: string[];
  memoryMB: number;
  maxMemoryMB: number;
}

export interface WasmCallOptions {
  returns?: WasmReturns;
  free?: boolean | string;
  alloc?: string | null;
  timeoutMs?: number;
}

export interface WasmRunOptions {
  name: string;
  args?: string[];
  env?: Record<string, string>;
  stdin?: Uint8Array | null;
  files?: WasmFile[];
  memoryMB?: number;
  timeoutMs?: number;
  /** The export to run; `_start`. */
  entry?: string;
}

export interface WasmRunResult {
  exitCode: number | null;
  error?: string;
  stdout: Uint8Array;
  stderr: Uint8Array;
  truncated: boolean;
  files: WasmFile[];
}

let blobUrl: string | null = null;

/** The worker's source: the function, called with the worker's own scope. */
export function wasmWorkerSource(): string {
  return `(${wasmWorkerMain.toString()})(self);\n`;
}

/** A worker from the source above, as a `blob:` address made once for the page. */
export function blobWasmWorker(): WasmWorkerLike {
  if (typeof Worker === 'undefined') throw new Error('WebAssembly modules run in a worker, and this host has none');
  blobUrl ??= URL.createObjectURL(new Blob([wasmWorkerSource()], { type: 'text/javascript' }));
  return new Worker(blobUrl) as unknown as WasmWorkerLike;
}

function randomHandle(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function seconds(ms: number): string {
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)} second${s === 1 ? '' : 's'}`;
}

/** A number of milliseconds an app asked for, kept within `max`; `fallback` when it asked for none. */
export function clampTimeout(asked: unknown, fallback: number, max: number): number {
  const n = typeof asked === 'number' ? asked : Number(asked);
  if (asked === undefined || asked === null || !Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.round(n), max);
}

// ------------------------------------------------------------ compiled modules

const compiled = new Map<string, { module: WebAssembly.Module; size: number }>();
const COMPILED_KEPT = 16;
/** The module files the kept compilations are of, together: an engine keeps each file's bytes beside its code. */
const COMPILED_BYTES_KEPT = 32 << 20;
let compiledBytes = 0;
/** What on the page runs WebAssembly now: apps' hosts and programs. When none is left, the kept compilations go. */
let compileUsers = 0;
/** Counts each letting go, so a compilation that was under way then is not kept after it. */
let compileGeneration = 0;

/** Lets go of every kept compilation. */
export function forgetCompiledWasm(): void {
  compiled.clear();
  compiledBytes = 0;
  compileGeneration++;
}

/**
 * Counts one more user of the kept compilations (a host, a program); the
 * function it gives counts it out, once, and lets them all go when it was
 * the last: an app that closes takes none of its modules' memory with it.
 */
function holdCompiled(): () => void {
  compileUsers++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    compileUsers--;
    if (compileUsers === 0) forgetCompiledWasm();
  };
}

/**
 * The module compiled, kept by the digest of its bytes so a command run again
 * (a tool called at each keystroke) is not compiled again: the most recently
 * used, at most COMPILED_KEPT of them and COMPILED_BYTES_KEPT of files. Without
 * Web Crypto (a page served over plain HTTP) it is compiled each time.
 */
async function compile(bytes: Uint8Array): Promise<WebAssembly.Module> {
  const generation = compileGeneration;
  let key: string | null = null;
  const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
  if (subtle) {
    try {
      const digest = new Uint8Array(await subtle.digest('SHA-256', bytes as BufferSource));
      key = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      key = null;
    }
  }
  if (key) {
    const kept = compiled.get(key);
    if (kept) {
      compiled.delete(key);
      compiled.set(key, kept);
      return kept.module;
    }
  }
  let module: WebAssembly.Module;
  try {
    module = await WebAssembly.compile(bytes as BufferSource);
  } catch (error) {
    throw new WasmFormatError(`The module is not valid WebAssembly: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (key && generation === compileGeneration && bytes.length <= COMPILED_BYTES_KEPT && !compiled.has(key)) {
    compiled.set(key, { module, size: bytes.length });
    compiledBytes += bytes.length;
    // The least recently used go first.
    for (const [oldest, entry] of compiled) {
      if (compiled.size <= COMPILED_KEPT && compiledBytes <= COMPILED_BYTES_KEPT) break;
      compiled.delete(oldest);
      compiledBytes -= entry.size;
    }
  }
  return module;
}

/**
 * The module read, checked and limited: what a worker is started with. Its
 * memory and tables have their ceilings written in, its imported memory and
 * tables are made with them, and what could not be held to them is refused.
 */
async function prepare(bytes: Uint8Array, caps: WasmCaps, maxModuleBytes: number): Promise<{ info: WasmModuleInfo; module: WebAssembly.Module }> {
  if (bytes.length > maxModuleBytes) {
    throw new Error(`The module is ${(bytes.length / 1048576).toFixed(1)} MB; a module may be at most ${maxModuleBytes / 1048576} MB`);
  }
  const info = readWasmModule(bytes);
  checkRunnable(info);
  const imports = cappedImports(info, caps);
  const module = await compile(capWasmModule(bytes, caps));
  return { info: { ...info, imports }, module };
}

function exportList(exports: WasmExport[]): WasmExportInfo[] {
  return exports.map((e) => (e.type ? { name: e.name, kind: e.kind, params: e.type.params, results: e.type.results } : { name: e.name, kind: e.kind }));
}

// --------------------------------------------------------------- one worker

type Reply = Extract<WasmWorkerReply, { id: number }>;
/** A request before the channel numbers it: `Omit` taken of each kind, not of the union (whose only shared key is `type`). */
type Unnumbered<T> = T extends unknown ? Omit<T, 'id'> : never;

interface Queued {
  message: Unnumbered<WasmWorkerRequest>;
  timeoutMs: number;
  what: string;
  transfer: Transferable[];
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
}

/**
 * A worker and the requests waiting on it; once dead, every request is
 * refused with why. The worker answers one request at a time, so they are
 * given to it one at a time, and each one's time is counted from then: a call
 * that waits behind a long one is not stopped for the time it waited.
 */
class WorkerChannel {
  readonly #worker: WasmWorkerLike;
  #next = 1;
  readonly #waiting: Queued[] = [];
  #current: (Queued & { id: number; timer: ReturnType<typeof setTimeout> | null }) | null = null;
  #dead: Error | null = null;
  /** Everything the worker says that answers no request: printing, posts, frames' sizes and sound. */
  onEvent: ((reply: WasmWorkerReply) => void) | null = null;
  /** Told once, when the worker dies. */
  onDeath: ((error: Error) => void) | null = null;

  constructor(worker: WasmWorkerLike, readonly label: string) {
    this.#worker = worker;
    worker.onmessage = (event) => this.#receive(event.data as WasmWorkerReply);
    worker.onerror = (event) => {
      event.preventDefault?.();
      this.kill(new Error(`${label}: the worker it ran in failed${event.message ? `: ${event.message}` : ''}`));
    };
  }

  #receive(reply: WasmWorkerReply): void {
    if (this.#dead) return;
    if ('id' in reply && (reply.type === 'ready' || reply.type === 'result' || reply.type === 'error' || reply.type === 'done' || reply.type === 'framed')) {
      const current = this.#current;
      if (!current || current.id !== reply.id) return;
      this.#current = null;
      if (current.timer) clearTimeout(current.timer);
      if (reply.type === 'error') current.reject(new Error(reply.message));
      else current.resolve(reply);
      this.#pump();
      return;
    }
    this.onEvent?.(reply);
  }

  /** Gives the worker the next request, when it has none. */
  #pump(): void {
    if (this.#dead || this.#current) return;
    const next = this.#waiting.shift();
    if (!next) return;
    const id = this.#next++;
    const timer =
      next.timeoutMs > 0
        ? setTimeout(() => this.kill(new Error(`${this.label}: ${next.what} took longer than ${seconds(next.timeoutMs)} and was stopped; the module is no longer running`)), next.timeoutMs)
        : null;
    this.#current = { ...next, id, timer };
    try {
      this.#worker.postMessage({ ...next.message, id }, next.transfer);
    } catch (error) {
      this.kill(new Error(`${this.label}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /** Queues a request and waits for its answer; past `timeoutMs` once it is the worker's, the worker is stopped and the module is gone. */
  request(message: Unnumbered<WasmWorkerRequest>, timeoutMs: number, what: string, transfer: Transferable[] = []): Promise<Reply> {
    if (this.#dead) return Promise.reject(this.#dead);
    return new Promise<Reply>((resolve, reject) => {
      this.#waiting.push({ message, timeoutMs, what, transfer, resolve, reject });
      this.#pump();
    });
  }

  kill(error: Error): void {
    if (this.#dead) return;
    this.#dead = error;
    try {
      this.#worker.terminate();
    } catch {
      // Already gone.
    }
    const current = this.#current;
    this.#current = null;
    if (current) {
      if (current.timer) clearTimeout(current.timer);
      current.reject(error);
    }
    for (const waiting of this.#waiting.splice(0)) waiting.reject(error);
    this.onDeath?.(error);
  }

  get dead(): Error | null {
    return this.#dead;
  }
}

function startMessage(
  mode: WasmMode,
  module: WebAssembly.Module,
  info: WasmModuleInfo,
  name: string,
  maxPages: number,
  limits: WasmLimits,
  extra: Partial<WasmStartMessage>
): Unnumbered<WasmStartMessage> {
  return {
    type: 'start',
    module,
    imports: info.imports,
    exports: info.exports,
    mode,
    name,
    maxPages,
    args: [],
    env: [],
    stdin: null,
    files: [],
    maxOutputBytes: limits.maxOutputBytes,
    maxFileBytes: limits.maxFileBytes,
    console: mode !== 'run',
    start: false,
    entry: '_start',
    canvas: null,
    audioRate: 48000,
    ...extra,
  };
}

function envList(env: Record<string, string> | undefined): string[] {
  return Object.entries(env ?? {}).map(([key, value]) => `${key}=${value}`);
}

function checkFiles(files: WasmFile[] | undefined, limits: WasmLimits): WasmFile[] {
  const list = files ?? [];
  const total = list.reduce((sum, f) => sum + f.bytes.length, 0);
  if (total > limits.maxFileBytes) throw new Error(`The files given to the module hold ${(total / 1048576).toFixed(1)} MB; at most ${limits.maxFileBytes / 1048576} MB`);
  return list;
}

/** What a module may grow to: the pages of memory `memoryMB` allows within the app's limits, and the table entries. */
function capsFor(memoryMB: number | undefined, limits: WasmLimits): WasmCaps {
  const mb = memoryMB === undefined || memoryMB === null || !Number.isFinite(memoryMB) || memoryMB <= 0 ? limits.memoryMB : memoryMB;
  if (mb > limits.maxMemoryMB) throw new Error(`A module may use at most ${limits.maxMemoryMB} MB of memory; it asked for ${mb} MB`);
  return { maxPages: Math.max(1, Math.floor((mb * 1048576) / WASM_PAGE_BYTES)), maxTableEntries: limits.maxTableEntries };
}

function consoleLogger(label: string): (stream: 'out' | 'err', text: string) => void {
  return (stream, text) => {
    if (stream === 'err') console.warn(`[${label}] ${text}`);
    // eslint-disable-next-line no-console -- the module's own printing, as an app's print() output is forwarded
    else console.log(`[${label}] ${text}`);
  };
}

// ----------------------------------------------------------------- programs

/** A running program's functions as an app's logic reaches them: see `startWasmProgram`. */
interface ProgramEntry {
  appId: string | undefined;
  call(name: string, args: WasmArg[], options: WasmCallOptions): Promise<unknown>;
  read(ptr: number, length: number, as: string): Promise<unknown>;
  write(ptr: number, bytes: Uint8Array): Promise<number>;
}

const programs = new Map<string, ProgramEntry>();
/** Programs still starting, by app: they count against its programs as the running ones do. */
const programsStarting = new Map<string | undefined, number>();

/**
 * The program a `<WasmApp>` of app `appId` runs under `handle`, or null. A
 * handle is a random name the program's own app is told when it starts; one
 * of another app's programs is not found from here, even by its name. An app
 * with no identity is one identity of its own, not every app's.
 */
function programFor(handle: string, appId: string | undefined): ProgramEntry | null {
  const entry = programs.get(handle);
  if (!entry || entry.appId !== appId) return null;
  return entry;
}

function programsOf(appId: string | undefined): number {
  let count = programsStarting.get(appId) ?? 0;
  for (const entry of programs.values()) if (entry.appId === appId) count++;
  return count;
}

export interface WasmProgramOptions {
  bytes: Uint8Array;
  name: string;
  /** The app it is drawn in: only that app's logic can call it. */
  appId?: string;
  /** Drawn on in the worker; null to be sent each frame's pixels instead (`onPixels`). */
  canvas: OffscreenCanvas | null;
  args?: string[];
  env?: Record<string, string>;
  files?: WasmFile[];
  memoryMB?: number;
  audioRate?: number;
  limits?: Partial<WasmLimits>;
  createWorker?: WasmWorkerFactory;
  /** Aborted, it stops the program, starting or running (a WasmApp taken off the page). */
  signal?: AbortSignal;
  onConsole?: (stream: 'out' | 'err', text: string) => void;
  onPost?: (text: string) => void;
  onSize?: (width: number, height: number) => void;
  onPixels?: (width: number, height: number, buffer: ArrayBuffer) => void;
  onAudio?: (samples: Float32Array) => void;
  /** The program called exit: no more frames. */
  onExit?: (code: number) => void;
  /** It stopped: a trap, a frame that never ended, a worker that failed. */
  onCrash?: (message: string) => void;
}

export interface WasmProgram {
  readonly handle: string;
  readonly name: string;
  readonly exports: WasmExportInfo[];
  readonly missing: string[];
  /** Whether it exports `frame`: a program that draws, rather than one that runs and prints. */
  readonly drawsFrames: boolean;
  /** Whether it imports `softn.audio`. */
  readonly makesSound: boolean;
  /** The code it exited with while starting, or null while it runs. */
  readonly exitCode: number | null;
  frame(time: number, events: WasmInputEvent[], audioQueued: number): Promise<void>;
  call(name: string, args: WasmArg[], options?: WasmCallOptions): Promise<unknown>;
  stop(): void;
}

/**
 * Starts a program that draws (`<WasmApp>`): `_initialize` or its `_start`
 * runs, then the component asks for a frame at a time. The program is
 * listed under its handle for its app's logic until `stop()`, or until
 * `signal` is aborted.
 */
export async function startWasmProgram(options: WasmProgramOptions): Promise<WasmProgram> {
  const limits: WasmLimits = { ...DEFAULT_WASM_LIMITS, ...options.limits };
  const stoppedEarly = () => new Error(`${options.name} was stopped`);
  if (options.signal?.aborted) throw stoppedEarly();
  if (programsOf(options.appId) >= limits.maxPrograms) {
    throw new Error(`An app runs at most ${limits.maxPrograms} WebAssembly programs at once`);
  }
  programsStarting.set(options.appId, (programsStarting.get(options.appId) ?? 0) + 1);
  const releaseCompiled = holdCompiled();
  const handle = randomHandle('wasmapp');
  let channel: WorkerChannel | null = null;
  let stopped = false;
  /** It called exit: once the request that saw it is answered, it is stopped (its worker and memory let go). */
  let exited = false;
  /** The program stops, its worker with it; nothing is reported. */
  const end = (why: Error) => {
    stopped = true;
    programs.delete(handle);
    options.signal?.removeEventListener('abort', abort);
    channel?.kill(why);
    releaseCompiled();
  };
  // Aborted, starting or running, the program stops as stop() stops it: no crash is reported.
  const abort = () => end(stoppedEarly());
  options.signal?.addEventListener('abort', abort, { once: true });
  const crash = (message: string) => {
    if (stopped) return;
    end(new Error(message));
    options.onCrash?.(message);
  };
  const afterExit = () => {
    if (exited && !stopped) end(new Error(`${options.name} has exited`));
  };
  let started: Extract<WasmWorkerReply, { type: 'ready' }>;
  let info: WasmModuleInfo;
  let module: WebAssembly.Module;
  try {
    const caps = capsFor(options.memoryMB, limits);
    ({ info, module } = await prepare(options.bytes, caps, limits.maxModuleBytes));
    const files = checkFiles(options.files, limits);
    if (options.signal?.aborted) throw stoppedEarly();
    const opened = new WorkerChannel((options.createWorker ?? blobWasmWorker)(), options.name);
    channel = opened;
    const onConsole = options.onConsole ?? consoleLogger(options.name);
    opened.onEvent = (reply) => {
      switch (reply.type) {
        case 'console':
          onConsole(reply.stream, reply.text);
          break;
        case 'post':
          options.onPost?.(reply.text);
          break;
        case 'size':
          options.onSize?.(reply.width, reply.height);
          break;
        case 'pixels':
          options.onPixels?.(reply.width, reply.height, reply.buffer);
          break;
        case 'audio':
          options.onAudio?.(reply.samples);
          break;
        case 'exit':
          exited = true;
          options.onExit?.(reply.code);
          break;
      }
    };
    // A program that fails while starting says so once, by the start's own rejection; onCrash
    // is for one that stops after it has started (onDeath is set below, once it has).
    const message = startMessage('program', module, info, options.name, caps.maxPages, limits, {
      args: options.args ?? [],
      env: envList(options.env),
      files,
      canvas: options.canvas,
      audioRate: options.audioRate ?? 48000,
    });
    started = (await opened.request(message, limits.loadTimeoutMs, 'starting', options.canvas ? [options.canvas as unknown as Transferable] : [])) as Extract<WasmWorkerReply, { type: 'ready' }>;
    if (options.signal?.aborted) throw stoppedEarly();
  } catch (error) {
    end(error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    const left = (programsStarting.get(options.appId) ?? 1) - 1;
    if (left > 0) programsStarting.set(options.appId, left);
    else programsStarting.delete(options.appId);
  }
  const running = channel as WorkerChannel;
  // Nothing has run between the start's answer and here: a worker's death arrives as a task of its own.
  running.onDeath = (error) => crash(error.message);
  const exports = exportList(info.exports);
  const entry: ProgramEntry = {
    appId: options.appId,
    call: async (name, args, callOptions) => {
      try {
        return await programCall(running, limits, name, args, callOptions);
      } finally {
        afterExit();
      }
    },
    read: async (ptr, length, as) => ((await running.request({ type: 'read', ptr, length, as }, limits.callTimeoutMs, 'reading its memory')) as { value: unknown }).value,
    write: async (ptr, bytes) => ((await running.request({ type: 'write', ptr, bytes }, limits.callTimeoutMs, 'writing its memory')) as { value: number }).value,
  };
  // One that exited as it started has run: it is told as exitCode, and stopped now.
  if (started.exitCode !== null) end(new Error(`${options.name} has exited`));
  else programs.set(handle, entry);
  return {
    handle,
    name: options.name,
    exports,
    missing: started.missing,
    drawsFrames: info.exports.some((e) => e.kind === 'function' && e.name === 'frame'),
    makesSound: info.imports.some((i) => i.kind === 'function' && i.module === 'softn' && i.name === 'audio'),
    exitCode: started.exitCode,
    async frame(time, events, audioQueued) {
      if (stopped) return;
      try {
        await running.request({ type: 'frame', time, events, audioQueued }, limits.frameTimeoutMs, 'a frame');
        afterExit();
      } catch (error) {
        crash(error instanceof Error ? error.message : String(error));
      }
    },
    call: (name, args, callOptions = {}) => entry.call(name, args, callOptions),
    stop() {
      if (!stopped) end(stoppedEarly());
    },
  };
}

async function programCall(channel: WorkerChannel, limits: WasmLimits, name: string, args: WasmArg[], options: WasmCallOptions): Promise<unknown> {
  const timeout = clampTimeout(options.timeoutMs, limits.callTimeoutMs, limits.maxCallTimeoutMs);
  // Bytes given to a call are copied across, not handed over: a view's buffer
  // may hold more than the view, and handing it over would empty all of it.
  const reply = (await channel.request(
    { type: 'call', name, args, returns: options.returns ?? 'number', free: options.free ?? false, alloc: options.alloc ?? null },
    timeout,
    `${name}()`
  )) as { value: unknown };
  return reply.value;
}

// --------------------------------------------------------------- the host

interface LoadedModule {
  channel: WorkerChannel;
  name: string;
}

export interface WasmHostOptions {
  createWorker?: WasmWorkerFactory;
  limits?: Partial<WasmLimits>;
  /** The app whose logic this host serves: it reaches only that app's programs. */
  appId?: string;
}

/** An app's modules: loaded, called, read, written, run and released. */
export class WasmHost {
  readonly limits: WasmLimits;
  readonly #modules = new Map<string, LoadedModule>();
  /** Loads not yet answered: they count against the app's modules. */
  #loading = 0;
  /** Commands running, those still being prepared included. */
  #running = 0;
  /** Workers of modules starting and of commands running: closing the app stops them too. */
  readonly #busy = new Set<WorkerChannel>();
  readonly #createWorker: WasmWorkerFactory;
  readonly #appId: string | undefined;
  /** Counts this host out of the page's kept compilations (see holdCompiled). */
  readonly #releaseCompiled = holdCompiled();
  #disposed = false;

  constructor(options: WasmHostOptions = {}) {
    this.limits = { ...DEFAULT_WASM_LIMITS, ...options.limits };
    this.#createWorker = options.createWorker ?? blobWasmWorker;
    this.#appId = options.appId;
  }

  #checkOpen(): void {
    if (this.#disposed) throw new Error('The app has closed');
  }

  async load(bytes: Uint8Array, options: WasmLoadOptions): Promise<WasmLoadResult> {
    this.#checkOpen();
    if (this.#modules.size + this.#loading >= this.limits.maxModules) {
      throw new Error(`An app keeps at most ${this.limits.maxModules} modules loaded at once; release one first (softn.wasm.release)`);
    }
    this.#loading++;
    let channel: WorkerChannel | null = null;
    try {
      const caps = capsFor(options.memoryMB, this.limits);
      const { info, module } = await prepare(bytes, caps, this.limits.maxModuleBytes);
      const files = checkFiles(options.files, this.limits);
      this.#checkOpen();
      const opened = new WorkerChannel(this.#createWorker(), options.name);
      channel = opened;
      this.#busy.add(opened);
      const onConsole = options.onConsole ?? consoleLogger(options.name);
      opened.onEvent = (reply) => {
        if (reply.type === 'console') onConsole(reply.stream, reply.text);
      };
      const handle = randomHandle('wasm');
      opened.onDeath = () => this.#modules.delete(handle);
      const reply = (await opened.request(
        startMessage('library', module, info, options.name, caps.maxPages, this.limits, {
          args: options.args ?? [],
          env: envList(options.env),
          files,
          start: options.start === true,
        }),
        this.limits.loadTimeoutMs,
        'starting'
      )) as Extract<WasmWorkerReply, { type: 'ready' }>;
      this.#checkOpen();
      if (reply.exitCode !== null) {
        // It ended as it started: there is nothing to call, and it keeps no place among the app's modules.
        throw new Error(`${options.name} exited (code ${reply.exitCode}) as it started, so it has no functions to call. softn.wasm.run runs a command from start to exit.`);
      }
      this.#modules.set(handle, { channel: opened, name: options.name });
      return {
        handle,
        name: options.name,
        kind: moduleKind(info),
        exports: exportList(info.exports),
        missing: reply.missing,
        memoryMB: Number(pagesToMB(reply.memoryPages)),
        maxMemoryMB: Number(pagesToMB(caps.maxPages)),
      };
    } catch (error) {
      // A module that failed to start, or started after the app closed, keeps no worker.
      channel?.kill(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      this.#loading--;
      if (channel) this.#busy.delete(channel);
    }
  }

  /** A loaded module, or a program of this app's under its handle. */
  #target(handle: string): ProgramEntry {
    this.#checkOpen();
    const module = this.#modules.get(handle);
    if (module) {
      const { channel } = module;
      return {
        appId: this.#appId,
        call: (name, args, options) => programCall(channel, this.limits, name, args, options),
        read: async (ptr, length, as) => ((await channel.request({ type: 'read', ptr, length, as }, this.limits.callTimeoutMs, 'reading its memory')) as { value: unknown }).value,
        write: async (ptr, bytes) => ((await channel.request({ type: 'write', ptr, bytes }, this.limits.callTimeoutMs, 'writing its memory')) as { value: number }).value,
      };
    }
    const program = programFor(handle, this.#appId);
    if (program) return program;
    throw new Error(`No module is running under "${handle}": it was released or stopped, or the handle is not one softn.wasm.load or a WasmApp gave`);
  }

  // Async, so an unknown handle is a rejected call like any other failure, not a throw.
  async call(handle: string, name: string, args: WasmArg[], options: WasmCallOptions = {}): Promise<unknown> {
    return this.#target(handle).call(name, args, options);
  }

  async read(handle: string, ptr: number, length: number, as: string): Promise<unknown> {
    return this.#target(handle).read(ptr, length, as);
  }

  async write(handle: string, ptr: number, bytes: Uint8Array): Promise<number> {
    return this.#target(handle).write(ptr, bytes);
  }

  release(handle: string): boolean {
    const module = this.#modules.get(handle);
    if (!module) return false;
    this.#modules.delete(handle);
    module.channel.kill(new Error(`${module.name} was released`));
    return true;
  }

  releaseAll(): number {
    const count = this.#modules.size;
    for (const handle of [...this.#modules.keys()]) this.release(handle);
    return count;
  }

  /** Runs a WASI command once, start to exit, in a worker of its own. */
  async run(bytes: Uint8Array, options: WasmRunOptions): Promise<WasmRunResult> {
    this.#checkOpen();
    if (this.#running >= this.limits.maxRuns) {
      throw new Error(`An app runs at most ${this.limits.maxRuns} commands at once; wait for one to finish`);
    }
    this.#running++;
    let channel: WorkerChannel | null = null;
    try {
      const caps = capsFor(options.memoryMB, this.limits);
      const { info, module } = await prepare(bytes, caps, this.limits.maxModuleBytes);
      const files = checkFiles(options.files, this.limits);
      const entry = options.entry || '_start';
      if (!info.exports.some((e) => e.kind === 'function' && e.name === entry)) {
        const kind = moduleKind(info);
        throw new Error(
          kind === 'command'
            ? `The module exports no "${entry}" to run`
            : `The module has no ${entry === '_start' ? 'main function (_start)' : `"${entry}"`} to run: it is a ${kind}. Load it with softn.wasm.load and call its functions, or build it as a command.`
        );
      }
      this.#checkOpen();
      const opened = new WorkerChannel(this.#createWorker(), options.name);
      channel = opened;
      this.#busy.add(opened);
      const timeout = clampTimeout(options.timeoutMs, this.limits.runTimeoutMs, this.limits.maxRunTimeoutMs);
      const done = (await opened.request(
        startMessage('run', module, info, options.name, caps.maxPages, this.limits, {
          args: options.args ?? [],
          env: envList(options.env),
          stdin: options.stdin ?? null,
          files,
          entry,
        }),
        timeout,
        'the run'
      )) as Extract<WasmWorkerReply, { type: 'done' }>;
      return {
        exitCode: done.exitCode,
        ...(done.error ? { error: done.error } : {}),
        stdout: done.stdout,
        stderr: done.stderr,
        truncated: done.truncated,
        files: done.files,
      };
    } finally {
      this.#running--;
      if (channel) {
        this.#busy.delete(channel);
        channel.kill(new Error(`${options.name} has finished`));
      }
    }
  }

  /**
   * Every module, every module starting and every run is stopped; nothing
   * more is started. The kept compilations go too, once nothing else on the
   * page runs WebAssembly.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.releaseAll();
    this.#disposed = true;
    for (const channel of this.#busy) channel.kill(new Error('The app has closed'));
    this.#busy.clear();
    this.#releaseCompiled();
  }
}
