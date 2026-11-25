/**
 * The worker a WebAssembly module runs in: one module, one worker, and only
 * what SoftN gives it.
 *
 * WHY ONE FUNCTION
 *
 * The worker is started from this function's own source text, as a `blob:`
 * address (wasm-host.ts): `(${wasmWorkerMain})(self)`. Every host SoftN runs
 * in allows a `blob:` worker, and the FormLogic frame, an opaque-origin
 * document, allows nothing else: it cannot start a worker from a file at
 * all. So the function names nothing outside itself: no import, no constant
 * of this module, nothing a bundler could move. Everything it needs is
 * declared inside it. wasm-host.test.ts keeps it so: it runs the text a host
 * would turn into a worker, not this function, and lists every name that
 * text takes from outside (only the globals a worker has). The types at the
 * top of the file are erased; they describe the messages for the host.
 *
 * WHAT A MODULE IS GIVEN
 *
 * SoftN runs no JavaScript an author ships with a module (Emscripten's,
 * wasm-bindgen's or Go's glue reach for the page itself). A module is
 * instantiated with these imports and nothing else:
 *
 * - `wasi_snapshot_preview1`, the WASI interface most compilers target:
 *   arguments and environment the call gives, clocks, random numbers, a
 *   file system held in this worker (the files the call gives, and whatever
 *   the module writes, which a run hands back), stdin from the call, stdout
 *   and stderr kept or shown in the console. No sockets, no network, no file
 *   of the device.
 * - `softn`, for a program that draws: `present` a frame of pixels, queue
 *   sound (`audio`, `audio_rate`, `audio_queued`), `post` a text to the app's
 *   logic, `log`, `now`.
 * - A few functions Emscripten's standalone builds import from `env`
 *   (`emscripten_resize_heap`, `emscripten_memcpy_js`, the clocks).
 * - Anything else it imports is still given, so the module starts: a memory,
 *   a table or a global of the size and type it asks for, and for a
 *   function, one that stops the module, naming the import, if it is called.
 *
 * The memory a module may grow to is written into the module before it gets
 * here (wasm-binary.ts `capWasmMemory`), or is the maximum of the memory made
 * for it; how long a call may take is the host's to enforce, by terminating
 * this worker.
 */

import type { WasmExport, WasmImport } from './wasm-binary';

/** One argument of a call, as the host has read it: numbers as they are, text and bytes to be copied into the module's memory. */
export type WasmArg = number | bigint | null | { text: string } | { bytes: Uint8Array };

/** How a call's answer is read: see `call` below. */
export type WasmReturns = 'number' | 'text' | 'json' | 'bytes' | 'cstring' | 'none';

/** What a module is run as: a library whose functions are called, a command run once, a program that draws. */
export type WasmMode = 'library' | 'run' | 'program';

export interface WasmStartMessage {
  type: 'start';
  id: number;
  module: WebAssembly.Module;
  imports: WasmImport[];
  exports: WasmExport[];
  mode: WasmMode;
  /** The module's name, for messages and as the command's first argument. */
  name: string;
  /** The most pages any memory made here may grow to. */
  maxPages: number;
  args: string[];
  /** `NAME=value`, in order. */
  env: string[];
  stdin: Uint8Array | null;
  files: { path: string; bytes: Uint8Array }[];
  /** Kept of stdout and of stderr each, for a run. */
  maxOutputBytes: number;
  /** All the files together may hold this much. */
  maxFileBytes: number;
  /** Whether output is shown in the console, line by line (a library or a program), rather than kept (a run). */
  console: boolean;
  /** For a library: run `_start` first (a module built as a command whose functions are then called). */
  start: boolean;
  /** For a run: the export to run, `_start` unless the call names another. */
  entry: string;
  /** For a program: the canvas it draws on, or null to send its pixels to the page instead. */
  canvas: OffscreenCanvas | null;
  /** For a program: the sound's sample rate. */
  audioRate: number;
}

export interface WasmCallMessage {
  type: 'call';
  id: number;
  name: string;
  args: WasmArg[];
  returns: WasmReturns;
  /** After reading a text, bytes or JSON answer: free it with the module's `dealloc`/`free`, or the export named. */
  free: boolean | string;
  /** The export that gives memory for a text or bytes argument; `alloc` or `malloc` when null. */
  alloc: string | null;
}

export interface WasmReadMessage {
  type: 'read';
  id: number;
  ptr: number;
  length: number;
  /** `bytes`, `text`, or a number type: `u8`, `i8`, `u16`, `i16`, `u32`, `i32`, `f32`, `f64` (`length` is then a count of them). */
  as: string;
}

export interface WasmWriteMessage {
  type: 'write';
  id: number;
  ptr: number;
  bytes: Uint8Array;
}

/** Something the person did, for a program, delivered before its next frame. */
export type WasmInputEvent =
  | { kind: 'key'; code: number; down: boolean }
  | { kind: 'text'; codepoint: number }
  | { kind: 'pointer'; id: number; phase: number; x: number; y: number; buttons: number }
  | { kind: 'wheel'; dx: number; dy: number }
  | { kind: 'resize'; width: number; height: number }
  | { kind: 'gamepad'; index: number; buttons: number; axes: number[] };

export interface WasmFrameMessage {
  type: 'frame';
  id: number;
  /** Milliseconds since the program started. */
  time: number;
  events: WasmInputEvent[];
  /** Seconds of sound queued on the page and not yet played. */
  audioQueued: number;
}

export type WasmWorkerRequest = WasmStartMessage | WasmCallMessage | WasmReadMessage | WasmWriteMessage | WasmFrameMessage;

export type WasmWorkerReply =
  | { type: 'ready'; id: number; memoryPages: number; missing: string[]; exitCode: number | null }
  | { type: 'result'; id: number; value: unknown }
  | { type: 'error'; id: number; message: string }
  | {
      type: 'done';
      id: number;
      exitCode: number | null;
      error: string | null;
      stdout: Uint8Array;
      stderr: Uint8Array;
      truncated: boolean;
      files: { path: string; bytes: Uint8Array }[];
    }
  | { type: 'console'; stream: 'out' | 'err'; text: string }
  | { type: 'post'; text: string }
  | { type: 'size'; width: number; height: number }
  | { type: 'pixels'; width: number; height: number; buffer: ArrayBuffer }
  | { type: 'audio'; samples: Float32Array }
  | { type: 'framed'; id: number }
  | { type: 'exit'; code: number };

/** What the function is handed: a worker's global scope, or a stand-in in tests. */
export interface WasmWorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/**
 * The worker. Called with the worker's `self`; it answers every message
 * posted to it, in order. Names nothing outside itself (see the head of the
 * file).
 */
export function wasmWorkerMain(scope: WasmWorkerScope): void {
  // WASI's error numbers, the ones this file answers with.
  const E = {
    SUCCESS: 0,
    TOOBIG: 1,
    BADF: 8,
    EXIST: 20,
    FAULT: 21,
    FBIG: 22,
    INVAL: 28,
    IO: 29,
    ISDIR: 31,
    MFILE: 33,
    NAMETOOLONG: 37,
    NOENT: 44,
    NOSPC: 51,
    NOSYS: 52,
    NOTDIR: 54,
    NOTEMPTY: 55,
    NOTSOCK: 57,
    NOTSUP: 58,
    SPIPE: 70,
    NOTCAPABLE: 76,
  };
  const FILETYPE_CHARACTER_DEVICE = 2;
  const FILETYPE_DIRECTORY = 3;
  const FILETYPE_REGULAR_FILE = 4;
  const ALL_RIGHTS = 0xffffffffffffffffn;
  /** Every right but fd_seek (bit 2) and fd_tell (bit 5): a terminal's. */
  const TTY_RIGHTS = ALL_RIGHTS & ~((1n << 2n) | (1n << 5n));
  const MAX_OPEN = 1024;
  /** The most buffers one read or write takes (POSIX's IOV_MAX, which wasi-libc's is). */
  const IOV_MAX = 1024;
  /** Files and folders a module may hold, together: each costs memory the byte limit does not see. */
  const MAX_NODES = 50000;
  const NAME_MAX = 255;
  const PATH_MAX = 4096;
  /** Lines shown in the console in one turn (a start, a call, a frame), both streams together. */
  const MAX_CONSOLE_LINES = 200;
  const MAX_LINE = 2000;
  /** The bytes of one line kept for the console: MAX_LINE characters of UTF-8 at most. */
  const LINE_BYTES = MAX_LINE * 4;
  const MAX_POSTS_PER_TURN = 100;
  const MAX_POST_BYTES = 1 << 20;
  const MAX_POST_BYTES_PER_TURN = 4 << 20;
  const MAX_AUDIO_POSTS_PER_TURN = 64;
  const MAX_SIDE = 4096;
  const MAX_SAFE = 9007199254740991n;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  interface FsFile {
    dir: false;
    data: Uint8Array;
    size: number;
    mtime: bigint;
    ino: number;
    /** Written by the module: handed back after a run. */
    touched: boolean;
    /** Its place among its folder's entries, for a listing's cookies: given when it is put there, never reused. */
    seq: number;
    /** Open file descriptors on it. */
    open: number;
    /** Taken out of its folder while open: its bytes still count until the last descriptor closes. */
    unlinked: boolean;
  }
  interface FsDir {
    dir: true;
    entries: Map<string, FsNode>;
    mtime: bigint;
    ino: number;
    seq: number;
    /** The next entry's place (1 and 2 are "." and ".."). */
    nextSeq: number;
    /** Removed while a descriptor still held it: nothing is made in it any more. */
    removed: boolean;
  }
  type FsNode = FsFile | FsDir;
  type Fd =
    | { kind: 'stdin' }
    | { kind: 'stdout' }
    | { kind: 'stderr' }
    | { kind: 'file'; node: FsFile; pos: number; append: boolean }
    | { kind: 'dir'; node: FsDir; preopen: string | null };
  interface Capture {
    /** A run's output, kept to hand back: its first `size` bytes, in one buffer however it was written. */
    data: Uint8Array;
    size: number;
    /** The line being written, for the console: its first LINE_BYTES bytes. */
    pending: Uint8Array[];
    pendingSize: number;
    /** A line has begun and not yet ended. */
    partial: boolean;
    /** The line being written is longer than what is kept of it. */
    cut: boolean;
  }

  // What the module is, once started.
  let mode: WasmMode = 'library';
  let moduleName = 'module';
  // An instance's exports have no prototype; this stays so before one exists.
  let exportsObj: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let importedMemory: WebAssembly.Memory | null = null;
  let maxPages = 4096;
  /** The code proc_exit was called with; the module takes no more calls after it. */
  let exitedWith: number | null = null;
  /** Between the start message and its answer. */
  let starting = false;
  const signatures = new Map<string, { params: string[]; results: string[] }>();
  let missing: string[] = [];
  const t0 = performance.now();

  // Its world.
  let argv: Uint8Array[] = [];
  let environ: Uint8Array[] = [];
  let stdin: Uint8Array = new Uint8Array(0);
  let stdinPos = 0;
  let maxOutput = 4 << 20;
  let keepOutput = false;
  let showConsole = true;
  let truncated = false;
  const output: Record<'out' | 'err', Capture> = {
    out: { data: new Uint8Array(0), size: 0, pending: [], pendingSize: 0, partial: false, cut: false },
    err: { data: new Uint8Array(0), size: 0, pending: [], pendingSize: 0, partial: false, cut: false },
  };
  // What one turn (a start, a call, a frame) has said and sent so far: see startTurn.
  let postsThisTurn = 0;
  let postBytesThisTurn = 0;
  let audioPostsThisTurn = 0;
  let audioFramesThisTurn = 0;
  let linesThisTurn = 0;
  let droppedLines = 0;
  let nextIno = 1;
  let fsBytes = 0;
  let maxFileBytes = 128 << 20;
  let nodeCount = 1;
  const root: FsDir = { dir: true, entries: new Map(), mtime: nowNs(), ino: nextIno++, seq: 0, nextSeq: 3, removed: false };
  const fds = new Map<number, Fd>();
  let nextFd = 5;

  // A program's screen and sound.
  let canvas: OffscreenCanvas | null = null;
  let context2d: OffscreenCanvasRenderingContext2D | null = null;
  let shownWidth = 0;
  let shownHeight = 0;
  let pendingPixels: { width: number; height: number; buffer: ArrayBuffer } | null = null;
  let audioRate = 48000;
  let audioQueued = 0;

  function post(message: WasmWorkerReply, transfer?: Transferable[]): void {
    scope.postMessage(message, transfer ?? []);
  }

  function nowNs(): bigint {
    return BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
  }

  function isExit(error: unknown): error is { softnExit: number } {
    return typeof error === 'object' && error !== null && 'softnExit' in error;
  }

  /** What went wrong, in words an app's author can act on. */
  function describe(error: unknown): string {
    if (isExit(error)) return `The module exited with code ${error.softnExit}`;
    if (error instanceof WebAssembly.RuntimeError) return `The module stopped: ${error.message}`;
    if (error instanceof WebAssembly.LinkError) return `The module could not be started: ${error.message}`;
    if (error instanceof WebAssembly.CompileError) return `The module is not valid WebAssembly: ${error.message}`;
    if (error instanceof Error) return error.message;
    return String(error);
  }

  // ---------------------------------------------------------------- memory

  function memory(): WebAssembly.Memory {
    const exported = exportsObj.memory;
    if (exported instanceof WebAssembly.Memory) return exported;
    if (importedMemory) return importedMemory;
    throw new Error('The module has no memory');
  }

  /** The module's memory as bytes, read anew each time: growing it replaces the buffer. */
  function heap(): Uint8Array {
    return new Uint8Array(memory().buffer);
  }

  function view(): DataView {
    return new DataView(memory().buffer);
  }

  /** `length` bytes at `ptr`, a view into the memory; a range past its end is the module's fault. */
  function region(ptr: number, length: number): Uint8Array {
    const bytes = heap();
    if (ptr < 0 || length < 0 || ptr + length > bytes.length) throw new RangeError(`The module named bytes ${ptr}..${ptr + length}, past the end of its memory (${bytes.length} bytes)`);
    return bytes.subarray(ptr, ptr + length);
  }

  function readText(ptr: number, length: number): string {
    return decoder.decode(region(ptr, length));
  }

  // ------------------------------------------------------------ the console

  function capture(stream: 'out' | 'err', bytes: Uint8Array): void {
    const sink = output[stream];
    if (keepOutput && bytes.length > 0) {
      // Appended to one buffer that doubles as it fills: a million one-byte writes cost a
      // megabyte, not a million objects.
      const room = maxOutput - sink.size;
      const n = Math.min(bytes.length, Math.max(room, 0));
      if (n < bytes.length) truncated = true;
      if (n > 0) {
        if (sink.size + n > sink.data.length) {
          const grown = new Uint8Array(Math.min(maxOutput, Math.max(sink.size + n, sink.data.length * 2, 4096)));
          grown.set(sink.data.subarray(0, sink.size));
          sink.data = grown;
        }
        sink.data.set(bytes.subarray(0, n), sink.size);
        sink.size += n;
      }
    }
    if (!showConsole || bytes.length === 0) return;
    let at = 0;
    while (at < bytes.length) {
      if (linesThisTurn >= MAX_CONSOLE_LINES) {
        // Past the turn's lines nothing more is kept or decoded: each line that ends is
        // counted in one pass over the bytes, and the count said once at the turn's end.
        let ended = 0;
        let last = -1;
        for (let i = at; i < bytes.length; i++) {
          if (bytes[i] === 10) {
            ended++;
            last = i;
          }
        }
        if (ended > 0) {
          droppedLines += ended;
          sink.pending = [];
          sink.pendingSize = 0;
          sink.cut = false;
          sink.partial = last < bytes.length - 1;
        } else {
          sink.partial = true;
        }
        return;
      }
      const newline = bytes.indexOf(10, at);
      const end = newline < 0 ? bytes.length : newline;
      // A line's first LINE_BYTES bytes are kept; the rest of a longer one is let go as it comes.
      const take = Math.min(end - at, LINE_BYTES - sink.pendingSize);
      if (take > 0) {
        sink.pending.push(bytes.slice(at, at + take));
        sink.pendingSize += take;
      }
      if (end - at > take) sink.cut = true;
      if (end > at) sink.partial = true;
      if (newline < 0) return;
      endLine(stream);
      at = newline + 1;
    }
  }

  /** The line being written has ended: shown, or counted when the turn has shown all it may. */
  function endLine(stream: 'out' | 'err'): void {
    const sink = output[stream];
    if (linesThisTurn >= MAX_CONSOLE_LINES) {
      droppedLines++;
    } else {
      linesThisTurn++;
      const bytes = new Uint8Array(sink.pendingSize);
      let at = 0;
      for (const chunk of sink.pending) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      const text = decoder.decode(bytes);
      post({ type: 'console', stream, text: sink.cut || text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…` : text });
    }
    sink.pending = [];
    sink.pendingSize = 0;
    sink.partial = false;
    sink.cut = false;
  }

  /** A turn begins: a start, a call or a frame. What it may say and send is counted afresh. */
  function startTurn(): void {
    postsThisTurn = 0;
    postBytesThisTurn = 0;
    audioPostsThisTurn = 0;
    audioFramesThisTurn = 0;
    linesThisTurn = 0;
    droppedLines = 0;
  }

  /** A turn ends: a line begun is shown as it is, and how many were not, once. */
  function endTurn(): void {
    if (!showConsole) return;
    if (output.out.partial) endLine('out');
    if (output.err.partial) endLine('err');
    if (droppedLines > 0) post({ type: 'console', stream: 'err', text: `… ${droppedLines} more lines not shown` });
    droppedLines = 0;
  }

  function joined(capture: Capture): Uint8Array {
    return capture.data.slice(0, capture.size);
  }

  // -------------------------------------------------------- the file system

  /** A new file, or null when the module holds as many files and folders as it may. */
  function newFile(data: Uint8Array): FsFile | null {
    if (nodeCount >= MAX_NODES) return null;
    nodeCount++;
    return { dir: false, data, size: data.length, mtime: nowNs(), ino: nextIno++, touched: false, seq: 0, open: 0, unlinked: false };
  }

  function newDir(): FsDir | null {
    if (nodeCount >= MAX_NODES) return null;
    nodeCount++;
    return { dir: true, entries: new Map(), mtime: nowNs(), ino: nextIno++, seq: 0, nextSeq: 3, removed: false };
  }

  /**
   * Puts `node` in `dir` as `name`, at the end of its listing: an entry is
   * always taken out before it is put back, so the listing's order is the
   * order of `seq`, which a folder never gives twice.
   */
  function place(dir: FsDir, name: string, node: FsNode): void {
    dir.entries.delete(name);
    node.seq = dir.nextSeq++;
    dir.entries.set(name, node);
    dir.mtime = nowNs();
  }

  /** A file or an empty folder leaves the files: its bytes and its place counted out, a file's once its last descriptor closes. */
  function discard(node: FsNode): void {
    if (node.dir) {
      // A descriptor may still hold it: nothing is made in it from here on (lookup).
      node.removed = true;
      nodeCount--;
      return;
    }
    if (node.open > 0) {
      node.unlinked = true;
      return;
    }
    fsBytes -= node.size;
    nodeCount--;
  }

  /** A descriptor on a file is closed: a file already taken out of its folder is gone with its last one. */
  function release(fd: Fd): void {
    if (fd.kind !== 'file') return;
    fd.node.open--;
    if (fd.node.open === 0 && fd.node.unlinked) {
      fsBytes -= fd.node.size;
      nodeCount--;
    }
  }

  /** A size or an offset (an unsigned 64-bit number) as a number, or Infinity past what one holds exactly. */
  function u64(value: bigint): number {
    const unsigned = BigInt.asUintN(64, value);
    return unsigned > MAX_SAFE ? Infinity : Number(unsigned);
  }

  /** Whether a name is longer than a file name may be: NAME_MAX bytes for one name, PATH_MAX for a path. */
  function tooLong(path: string, parts: string[]): boolean {
    return encoder.encode(path).length > PATH_MAX || parts.some((part) => encoder.encode(part).length > NAME_MAX);
  }

  /** A file the call gave, at its path from the root, with the folders it is in. */
  function addFile(path: string, data: Uint8Array): void {
    const parts = path.split('/').filter((p) => p !== '' && p !== '.');
    if (parts.length === 0 || parts.includes('..')) throw new Error(`The file name "${path}" names no place in the module's files`);
    if (tooLong(path, parts)) throw new Error(`The file name "${path.slice(0, 80)}…" is longer than a file name may be`);
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.entries.get(part);
      if (!next) {
        next = newDir() ?? undefined;
        if (!next) throw new Error('The files given to the module are more than it may hold');
        place(dir, part, next);
      }
      if (!next.dir) throw new Error(`"${part}" in "${path}" is a file, not a folder`);
      dir = next;
    }
    const name = parts[parts.length - 1];
    const existing = dir.entries.get(name);
    if (existing?.dir) throw new Error(`"${path}" is a folder of the files given, not a file`);
    if (fsBytes - (existing?.size ?? 0) + data.length > maxFileBytes) throw new Error('The files given to the module are larger than it may hold');
    if (existing) discard(existing);
    const file = newFile(data);
    if (!file) throw new Error('The files given to the module are more than it may hold');
    place(dir, name, file);
    fsBytes += data.length;
  }

  /**
   * Grow or shrink a file to `size` bytes; false when the files would then
   * hold more than they may. The bytes counted are the files' sizes, and a
   * file's buffer is never more than twice its size (or 64 bytes): it grows by
   * doubling, and one made less than half as large is given a buffer of its
   * new size. So the memory the files take stays within twice what they may
   * hold, however often they are grown and cut back.
   */
  function resize(file: FsFile, size: number): boolean {
    if (!Number.isFinite(size) || size < 0 || size > maxFileBytes) return false;
    if (size > file.size && fsBytes + (size - file.size) > maxFileBytes) return false;
    if (size > file.data.length) {
      const grown = new Uint8Array(Math.max(size, Math.min(file.data.length * 2, size + (16 << 20)), 64));
      grown.set(file.data.subarray(0, file.size));
      file.data = grown;
    } else if (size < file.size) {
      if (size < file.data.length / 2) {
        // What a file no longer holds is not kept for it.
        file.data = file.data.slice(0, size);
      } else {
        file.data.fill(0, size, file.size);
      }
    }
    fsBytes += size - file.size;
    file.size = size;
    file.mtime = nowNs();
    file.touched = true;
    return true;
  }

  type Found = { errno: number } | { parent: FsDir; name: string; node: FsNode | undefined; trailingSlash: boolean };

  /**
   * `path` from the folder `dirFd` holds: its folder, its last name, and what
   * is there. A path may not leave the folder it starts in (`..` past it, or
   * a path from the root), as WASI asks of a runtime.
   */
  function lookup(dirFd: number, path: string): Found {
    const base = fds.get(dirFd);
    if (!base) return { errno: E.BADF };
    if (base.kind !== 'dir') return { errno: E.NOTDIR };
    if (path === '') return { errno: E.NOENT };
    if (path.startsWith('/')) return { errno: E.NOTCAPABLE };
    if (path.includes('\0')) return { errno: E.INVAL };
    const trailingSlash = path.endsWith('/');
    const parts = path.split('/').filter((p) => p !== '' && p !== '.');
    if (tooLong(path, parts)) return { errno: E.NAMETOOLONG };
    const stack: FsDir[] = [base.node];
    let name = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === '..') {
        if (stack.length === 1) return { errno: E.NOTCAPABLE };
        stack.pop();
        name = '';
        continue;
      }
      if (i === parts.length - 1) {
        name = part;
        break;
      }
      const next = stack[stack.length - 1].entries.get(part);
      if (!next) return { errno: E.NOENT };
      if (!next.dir) return { errno: E.NOTDIR };
      stack.push(next);
    }
    const parent = stack[stack.length - 1];
    if (name === '') return { parent, name: '', node: parent, trailingSlash };
    // A folder removed while a descriptor held it has no entries, and takes none (POSIX's ENOENT).
    if (parent.removed) return { errno: E.NOENT };
    const node = parent.entries.get(name);
    if (trailingSlash && node && !node.dir) return { errno: E.NOTDIR };
    return { parent, name, node, trailingSlash };
  }

  function openFd(fd: Fd): number {
    if (fds.size >= MAX_OPEN) return -1;
    while (fds.has(nextFd)) nextFd++;
    const number = nextFd++;
    fds.set(number, fd);
    return number;
  }

  function writeFilestat(ptr: number, node: FsNode | null, filetype: number): void {
    const dv = view();
    region(ptr, 64);
    dv.setBigUint64(ptr, 0n, true);
    dv.setBigUint64(ptr + 8, BigInt(node ? node.ino : 0), true);
    dv.setUint8(ptr + 16, filetype);
    dv.setBigUint64(ptr + 24, 1n, true);
    dv.setBigUint64(ptr + 32, BigInt(node && !node.dir ? node.size : 0), true);
    const time = node ? node.mtime : 0n;
    dv.setBigUint64(ptr + 40, time, true);
    dv.setBigUint64(ptr + 48, time, true);
    dv.setBigUint64(ptr + 56, time, true);
  }

  /**
   * The buffers an iovec array names, as views into the memory: the first
   * IOV_MAX of them. A list longer than that is read or written in part, a
   * short read or write its caller goes on from (as wasi-libc and Rust's
   * write_all do); what one call takes stays bounded.
   */
  function iovecs(ptr: number, total: number): Uint8Array[] {
    const count = Math.min(total, IOV_MAX);
    const dv = view();
    region(ptr, count * 8);
    const out: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const base = dv.getUint32(ptr + i * 8, true);
      const length = dv.getUint32(ptr + i * 8 + 4, true);
      out.push(region(base, length));
    }
    return out;
  }

  function readInto(buffers: Uint8Array[], source: Uint8Array, from: number, end: number): number {
    let at = from;
    for (const buffer of buffers) {
      if (at >= end) break;
      const n = Math.min(buffer.length, end - at);
      buffer.set(source.subarray(at, at + n));
      at += n;
    }
    return at - from;
  }

  function writeFrom(file: FsFile, buffers: Uint8Array[], at: number): number {
    const total = buffers.reduce((sum, b) => sum + b.length, 0);
    if (at + total > file.size && !resize(file, at + total)) return -1;
    let pos = at;
    for (const buffer of buffers) {
      file.data.set(buffer, pos);
      pos += buffer.length;
    }
    file.mtime = nowNs();
    file.touched = true;
    return total;
  }

  function clockNs(id: number): bigint | null {
    if (id === 0) return nowNs();
    if (id === 1 || id === 2 || id === 3) return BigInt(Math.round(performance.now() * 1e6));
    return null;
  }

  // ------------------------------------------------------------------- WASI

  /** Every WASI call: an error number, the module's own faults answered as EFAULT, proc_exit let through. */
  function guarded(fn: (...args: never[]) => number): (...args: unknown[]) => number {
    return (...args: unknown[]) => {
      try {
        return (fn as (...a: unknown[]) => number)(...args);
      } catch (error) {
        if (isExit(error)) throw error;
        if (error instanceof RangeError) return E.FAULT;
        return E.IO;
      }
    };
  }

  function strings(list: Uint8Array[], pointersPtr: number, bufferPtr: number): number {
    const dv = view();
    let at = bufferPtr;
    list.forEach((item, i) => {
      dv.setUint32(pointersPtr + i * 4, at, true);
      region(at, item.length + 1).set(item);
      heap()[at + item.length] = 0;
      at += item.length + 1;
    });
    return E.SUCCESS;
  }

  function sizes(list: Uint8Array[], countPtr: number, sizePtr: number): number {
    const dv = view();
    dv.setUint32(countPtr, list.length, true);
    dv.setUint32(sizePtr, list.reduce((sum, item) => sum + item.length + 1, 0), true);
    return E.SUCCESS;
  }

  const wasi = table<(...args: never[]) => number>({
    args_get: (argvPtr: number, bufPtr: number) => strings(argv, argvPtr, bufPtr),
    args_sizes_get: (countPtr: number, sizePtr: number) => sizes(argv, countPtr, sizePtr),
    environ_get: (envPtr: number, bufPtr: number) => strings(environ, envPtr, bufPtr),
    environ_sizes_get: (countPtr: number, sizePtr: number) => sizes(environ, countPtr, sizePtr),
    clock_res_get: (id: number, ptr: number) => {
      if (clockNs(id) === null) return E.INVAL;
      // A microsecond: what performance.now() is good for in a worker.
      view().setBigUint64(ptr, 1000n, true);
      return E.SUCCESS;
    },
    clock_time_get: (id: number, _precision: bigint, ptr: number) => {
      const ns = clockNs(id);
      if (ns === null) return E.INVAL;
      view().setBigUint64(ptr, ns, true);
      return E.SUCCESS;
    },
    fd_advise: (fd: number) => (fds.has(fd) ? E.SUCCESS : E.BADF),
    fd_allocate: (fd: number, offset: bigint, length: bigint) => {
      const f = fds.get(fd);
      if (!f) return E.BADF;
      if (f.kind !== 'file') return f.kind === 'dir' ? E.ISDIR : E.SPIPE;
      // Sizes are unsigned: a negative one is a size past any a file may have.
      const end = u64(offset) + u64(length);
      if (end > maxFileBytes) return E.FBIG;
      if (end > f.node.size && !resize(f.node, end)) return E.NOSPC;
      return E.SUCCESS;
    },
    fd_close: (fd: number) => {
      const f = fds.get(fd);
      if (!f) return E.BADF;
      fds.delete(fd);
      release(f);
      return E.SUCCESS;
    },
    fd_datasync: (fd: number) => (fds.has(fd) ? E.SUCCESS : E.BADF),
    fd_sync: (fd: number) => (fds.has(fd) ? E.SUCCESS : E.BADF),
    fd_fdstat_get: (fd: number, ptr: number) => {
      const f = fds.get(fd);
      if (!f) return E.BADF;
      const dv = view();
      region(ptr, 24);
      const type = f.kind === 'file' ? FILETYPE_REGULAR_FILE : f.kind === 'dir' ? FILETYPE_DIRECTORY : FILETYPE_CHARACTER_DEVICE;
      // Where printing goes to the console, line by line, stdin, stdout and stderr are a
      // terminal: a character device that cannot seek or tell, which is what wasi-libc's
      // isatty() looks for, so a C program's stdout is line-buffered and shows as it prints.
      // A run's output is collected instead, and looks like a pipe (no colours, full buffers).
      const rights = type === FILETYPE_CHARACTER_DEVICE && showConsole ? TTY_RIGHTS : ALL_RIGHTS;
      dv.setUint8(ptr, type);
      dv.setUint16(ptr + 2, f.kind === 'file' && f.append ? 1 : 0, true);
      dv.setBigUint64(ptr + 8, rights, true);
      dv.setBigUint64(ptr + 16, rights, true);
      return E.SUCCESS;
    },
    fd_fdstat_set_flags: (fd: number, flags: number) => {
      const f = fds.get(fd);
      if (!f) return E.BADF;
      if (f.kind === 'file') f.append = (flags & 1) !== 0;
      return E.SUCCESS;
    },
    fd_fdstat_set_rights: (fd: number) => (fds.has(fd) ? E.SUCCESS : E.BADF),
    fd_filestat_get: (fd: number, ptr: number) => {
      const f = fds.get(fd);
      if (!f) return E.BADF;
      if (f.kind === 'file') writeFilestat(ptr, f.node, FILETYPE_REGULAR_FILE);
      else if (f.kind === 'dir') writeFilestat(ptr, f.node, FILETYPE_DIRECTORY);
      else writeFilestat(ptr, null, FILETYPE_CHARACTER_DEVICE);
      return E.SUCCESS;
    },
    fd_filestat_set_size: (fd: number, size: bigint) => {
      const f = fds.get(fd);
      if (!f) return E.BADF;
      if (f.kind !== 'file') return f.kind === 'dir' ? E.ISDIR : E.INVAL;
      const wanted = u64(size);
      if (wanted > maxFileBytes) return E.FBIG;
      return resize(f.node, wanted) ? E.SUCCESS : E.NOSPC;
    },
    fd_filestat_set_times: (fd: number) => {
      const f = fds.get(fd);
      if (!f) return E.BADF;
      if (f.kind === 'file' || f.kind === 'dir') f.node.mtime = nowNs();
      return E.SUCCESS;
    },
    fd_pread: (fd: number, iovs: number, count: number, offset: bigint, nreadPtr: number) => {
      const f = fds.get(fd);
      if (!f) return E.BADF;
      if (f.kind !== 'file') return f.kind === 'dir' ? E.ISDIR : E.SPIPE;
      const at = u64(offset);
      const buffers = iovecs(iovs, count);
      const n = at >= f.node.size ? 0 : readInto(buffers, f.node.data, at, f.node.size);
      view().setUint32(nreadPtr, n, true);
      return E.SUCCESS;
    },
    fd_pwrite: (fd: number, iovs: number, count: number, offset: bigint, nwrittenPtr: number) => {
      const f = fds.get(fd);
      if (!f) return E.BADF;
      if (f.kind !== 'file') return f.kind === 'dir' ? E.ISDIR : E.SPIPE;
      const at = u64(offset);
      if (at > maxFileBytes) return E.FBIG;
      const n = writeFrom(f.node, iovecs(iovs, count), at);
      if (n < 0) return E.NOSPC;
      view().setUint32(nwrittenPtr, n, true);
      return E.SUCCESS;
    },
    fd_prestat_get: (fd: number, ptr: number) => {
      const f = fds.get(fd);
      if (!f || f.kind !== 'dir' || f.preopen === null) return E.BADF;
      const dv = view();
      region(ptr, 8);
      dv.setUint8(ptr, 0);
      dv.setUint32(ptr + 4, encoder.encode(f.preopen).length, true);
      return E.SUCCESS;
    },
    fd_prestat_dir_name: (fd: number, ptr: number, length: number) => {
      const f = fds.get(fd);
      if (!f || f.kind !== 'dir' || f.preopen === null) return E.BADF;
      const name = encoder.encode(f.preopen);
      region(ptr, Math.min(length, name.length)).set(name.subarray(0, Math.min(length, name.length)));
      return E.SUCCESS;
    },
    fd_read: (fd: number, iovs: number, count: number, nreadPtr: number) => {
      const f = fds.get(fd);
      if (!f) return E.BADF;
      let n: number;
      if (f.kind === 'stdin') {
        n = readInto(iovecs(iovs, count), stdin, stdinPos, stdin.length);
        stdinPos += n;
      } else if (f.kind === 'file') {
        n = readInto(iovecs(iovs, count), f.node.data, f.pos, f.node.size);
        f.pos += n;
      } else if (f.kind === 'dir') {
        return E.ISDIR;
      } else {
        return E.BADF;
      }
      view().setUint32(nreadPtr, n, true);
      return E.SUCCESS;
    },
    fd_readdir: (fd: number, buf: number, bufLen: number, cookie: bigint, usedPtr: number) => {
      const f = fds.get(fd);
      if (!f) return E.BADF;
      if (f.kind !== 'dir') return E.NOTDIR;
      const target = region(buf, bufLen);
      // A cookie is the place of the entry read last (`seq`), which no change to the folder
      // moves: an entry taken out while a listing goes on leaves the rest where they were.
      const after = u64(cookie);
      const listing: { name: string; node: FsNode; seq: number }[] = [
        { name: '.', node: f.node, seq: 1 },
        { name: '..', node: f.node, seq: 2 },
        ...[...f.node.entries].map(([name, node]) => ({ name, node, seq: node.seq })),
      ];
      let used = 0;
      for (const item of listing) {
        if (item.seq <= after) continue;
        const node = item.node;
        const name = encoder.encode(item.name);
        const entry = new Uint8Array(24 + name.length);
        const ev = new DataView(entry.buffer);
        ev.setBigUint64(0, BigInt(item.seq), true);
        ev.setBigUint64(8, BigInt(node.ino), true);
        ev.setUint32(16, name.length, true);
        ev.setUint8(20, node.dir ? FILETYPE_DIRECTORY : FILETYPE_REGULAR_FILE);
        entry.set(name, 24);
        const room = bufLen - used;
        if (entry.length > room) {
          // As much as fits: a full buffer tells the reader there is more.
          target.set(entry.subarray(0, room), used);
          used = bufLen;
          break;
        }
        target.set(entry, used);
        used += entry.length;
      }
      view().setUint32(usedPtr, used, true);
      return E.SUCCESS;
    },
    fd_renumber: (from: number, to: number) => {
      const f = fds.get(from);
      const replaced = fds.get(to);
      if (!f || !replaced) return E.BADF;
      // Onto itself it changes nothing, as dup2(fd, fd) does not.
      if (from === to) return E.SUCCESS;
      fds.set(to, f);
      fds.delete(from);
      release(replaced);
      return E.SUCCESS;
    },
    fd_seek: (fd: number, offset: bigint, whence: number, newPtr: number) => {
      const f = fds.get(fd);
      if (!f) return E.BADF;
      if (f.kind !== 'file') return f.kind === 'dir' ? E.ISDIR : E.SPIPE;
      const base = whence === 0 ? 0 : whence === 1 ? f.pos : whence === 2 ? f.node.size : -1;
      if (base < 0) return E.INVAL;
      // A seek's offset is signed (it may go back); where it lands is a position, which is not.
      const pos = base + Number(BigInt.asIntN(64, offset));
      if (pos < 0 || pos > Number.MAX_SAFE_INTEGER) return E.INVAL;
      f.pos = pos;
      view().setBigUint64(newPtr, BigInt(pos), true);
      return E.SUCCESS;
    },
    fd_tell: (fd: number, ptr: number) => {
      const f = fds.get(fd);
      if (!f) return E.BADF;
      if (f.kind !== 'file') return E.SPIPE;
      view().setBigUint64(ptr, BigInt(f.pos), true);
      return E.SUCCESS;
    },
    fd_write: (fd: number, iovs: number, count: number, nwrittenPtr: number) => {
      const f = fds.get(fd);
      if (!f) return E.BADF;
      const buffers = iovecs(iovs, count);
      let n: number;
      if (f.kind === 'stdout' || f.kind === 'stderr') {
        n = 0;
        for (const buffer of buffers) {
          capture(f.kind === 'stdout' ? 'out' : 'err', buffer);
          n += buffer.length;
        }
      } else if (f.kind === 'file') {
        const at = f.append ? f.node.size : f.pos;
        n = writeFrom(f.node, buffers, at);
        if (n < 0) return E.NOSPC;
        f.pos = at + n;
      } else if (f.kind === 'dir') {
        return E.ISDIR;
      } else {
        return E.BADF;
      }
      view().setUint32(nwrittenPtr, n, true);
      return E.SUCCESS;
    },
    path_create_directory: (fd: number, ptr: number, length: number) => {
      const found = lookup(fd, readText(ptr, length));
      if ('errno' in found) return found.errno;
      if (found.name === '' || found.node) return E.EXIST;
      const dir = newDir();
      if (!dir) return E.NOSPC;
      place(found.parent, found.name, dir);
      return E.SUCCESS;
    },
    path_filestat_get: (fd: number, _flags: number, ptr: number, length: number, statPtr: number) => {
      const found = lookup(fd, readText(ptr, length));
      if ('errno' in found) return found.errno;
      if (!found.node) return E.NOENT;
      writeFilestat(statPtr, found.node, found.node.dir ? FILETYPE_DIRECTORY : FILETYPE_REGULAR_FILE);
      return E.SUCCESS;
    },
    path_filestat_set_times: (fd: number, _flags: number, ptr: number, length: number) => {
      const found = lookup(fd, readText(ptr, length));
      if ('errno' in found) return found.errno;
      if (!found.node) return E.NOENT;
      found.node.mtime = nowNs();
      return E.SUCCESS;
    },
    path_link: () => E.NOTSUP,
    path_open: (
      dirFd: number,
      _dirflags: number,
      ptr: number,
      length: number,
      oflags: number,
      _rightsBase: bigint,
      _rightsInheriting: bigint,
      fdflags: number,
      fdPtr: number
    ) => {
      const found = lookup(dirFd, readText(ptr, length));
      if ('errno' in found) return found.errno;
      const create = (oflags & 1) !== 0;
      const directory = (oflags & 2) !== 0;
      const exclusive = (oflags & 4) !== 0;
      const truncate = (oflags & 8) !== 0;
      let node = found.node;
      if (node) {
        if (create && exclusive) return E.EXIST;
        if (directory && !node.dir) return E.NOTDIR;
        if (node.dir && truncate) return E.ISDIR;
        if (!node.dir && truncate) resize(node, 0);
      } else {
        if (!create) return E.NOENT;
        if (directory || found.trailingSlash) return E.ISDIR;
        const made = newFile(new Uint8Array(0));
        if (!made) return E.NOSPC;
        made.touched = true;
        place(found.parent, found.name, made);
        node = made;
      }
      const fd = openFd(node.dir ? { kind: 'dir', node, preopen: null } : { kind: 'file', node, pos: 0, append: (fdflags & 1) !== 0 });
      if (fd < 0) return E.MFILE;
      if (!node.dir) node.open++;
      view().setUint32(fdPtr, fd, true);
      return E.SUCCESS;
    },
    path_readlink: (fd: number, ptr: number, length: number) => {
      const found = lookup(fd, readText(ptr, length));
      if ('errno' in found) return found.errno;
      return found.node ? E.INVAL : E.NOENT;
    },
    path_remove_directory: (fd: number, ptr: number, length: number) => {
      const found = lookup(fd, readText(ptr, length));
      if ('errno' in found) return found.errno;
      if (found.name === '') return E.INVAL;
      if (!found.node) return E.NOENT;
      if (!found.node.dir) return E.NOTDIR;
      if (found.node.entries.size > 0) return E.NOTEMPTY;
      // A folder some descriptor still holds may be removed (POSIX lets it); the descriptor keeps
      // an empty folder no path reaches, and nothing can be made in it through a path.
      found.parent.entries.delete(found.name);
      found.parent.mtime = nowNs();
      discard(found.node);
      return E.SUCCESS;
    },
    path_rename: (fromFd: number, fromPtr: number, fromLength: number, toFd: number, toPtr: number, toLength: number) => {
      const from = lookup(fromFd, readText(fromPtr, fromLength));
      if ('errno' in from) return from.errno;
      const to = lookup(toFd, readText(toPtr, toLength));
      if ('errno' in to) return to.errno;
      if (from.name === '' || to.name === '') return E.INVAL;
      const node = from.node;
      if (!node) return E.NOENT;
      if (to.node === node) return E.SUCCESS;
      if (node.dir) {
        // A folder may not be moved into itself.
        const inside = (dir: FsDir): boolean => dir === to.parent || [...dir.entries.values()].some((child) => child.dir && inside(child));
        if (inside(node)) return E.INVAL;
        if (to.node && !to.node.dir) return E.NOTDIR;
        if (to.node && to.node.dir && to.node.entries.size > 0) return E.NOTEMPTY;
      } else if (to.node && to.node.dir) {
        return E.ISDIR;
      }
      // What it replaces leaves the files (a file still open stays counted until it is closed);
      // what moves keeps its bytes and takes a new place in its new folder's listing.
      if (to.node) {
        to.parent.entries.delete(to.name);
        discard(to.node);
      }
      from.parent.entries.delete(from.name);
      from.parent.mtime = nowNs();
      place(to.parent, to.name, node);
      if (!node.dir) node.touched = true;
      return E.SUCCESS;
    },
    path_symlink: () => E.NOTSUP,
    path_unlink_file: (fd: number, ptr: number, length: number) => {
      const found = lookup(fd, readText(ptr, length));
      if ('errno' in found) return found.errno;
      if (!found.node) return E.NOENT;
      if (found.node.dir) return E.ISDIR;
      found.parent.entries.delete(found.name);
      found.parent.mtime = nowNs();
      // Its bytes count until its last descriptor is closed.
      discard(found.node);
      return E.SUCCESS;
    },
    poll_oneoff: (inPtr: number, outPtr: number, count: number, neventsPtr: number) => {
      if (count === 0) return E.INVAL;
      region(inPtr, count * 48);
      region(outPtr, count * 32);
      const dv = view();
      const clocks: { userdata: bigint; deadline: number }[] = [];
      const waits: { userdata: bigint; type: number; fd: number }[] = [];
      for (let i = 0; i < count; i++) {
        const base = inPtr + i * 48;
        const userdata = dv.getBigUint64(base, true);
        const type = dv.getUint8(base + 8);
        if (type === 0) {
          const clock = dv.getUint32(base + 16, true);
          const timeout = dv.getBigUint64(base + 24, true);
          const absolute = (dv.getUint16(base + 40, true) & 1) !== 0;
          const now = clockNs(clock) ?? BigInt(Math.round(performance.now() * 1e6));
          const wait = absolute ? Number(timeout - now) / 1e6 : Number(timeout) / 1e6;
          clocks.push({ userdata, deadline: performance.now() + Math.max(0, wait) });
        } else {
          waits.push({ userdata, type, fd: dv.getUint32(base + 16, true) });
        }
      }
      let events = 0;
      const event = (userdata: bigint, error: number, type: number, bytes: number) => {
        const base = outPtr + events * 32;
        dv.setBigUint64(base, userdata, true);
        dv.setUint16(base + 8, error, true);
        dv.setUint8(base + 10, type);
        dv.setBigUint64(base + 16, BigInt(bytes), true);
        dv.setUint16(base + 24, 0, true);
        events++;
      };
      if (waits.length > 0) {
        // Every file this worker holds is ready at once: nothing here waits on anything.
        for (const wait of waits) {
          const f = fds.get(wait.fd);
          if (!f) {
            event(wait.userdata, E.BADF, wait.type, 0);
            continue;
          }
          const ready = f.kind === 'stdin' ? stdin.length - stdinPos : f.kind === 'file' ? Math.max(0, f.node.size - f.pos) : 0;
          event(wait.userdata, 0, wait.type, ready);
        }
      } else {
        // A sleep. A worker can wait for nothing but time here, so it waits by
        // the clock; a sleep longer than the call may take is ended by the
        // host, which stops this worker.
        const soonest = Math.min(...clocks.map((c) => c.deadline));
        while (performance.now() < soonest) {
          // Waiting.
        }
        for (const clock of clocks) if (clock.deadline <= performance.now()) event(clock.userdata, 0, 0, 0);
      }
      dv.setUint32(neventsPtr, events, true);
      return E.SUCCESS;
    },
    proc_exit: (code: number) => {
      throw { softnExit: code >>> 0 };
    },
    proc_raise: () => E.NOSYS,
    sched_yield: () => E.SUCCESS,
    random_get: (ptr: number, length: number) => {
      const target = region(ptr, length);
      for (let at = 0; at < length; at += 65536) crypto.getRandomValues(target.subarray(at, Math.min(length, at + 65536)));
      return E.SUCCESS;
    },
    sock_accept: (fd: number) => (fds.has(fd) ? E.NOTSOCK : E.BADF),
    sock_recv: (fd: number) => (fds.has(fd) ? E.NOTSOCK : E.BADF),
    sock_send: (fd: number) => (fds.has(fd) ? E.NOTSOCK : E.BADF),
    sock_shutdown: (fd: number) => (fds.has(fd) ? E.NOTSOCK : E.BADF),
  });

  // ------------------------------------------------- softn: what a program asks

  let pendingSize: { width: number; height: number } | null = null;

  function present(ptr: number, width: number, height: number): void {
    const w = width >>> 0;
    const h = height >>> 0;
    if (w === 0 || h === 0 || w > MAX_SIDE || h > MAX_SIDE) throw new Error(`present: a frame is 1 to ${MAX_SIDE} pixels on each side; this one is ${w} by ${h}`);
    const pixels = region(ptr >>> 0, w * h * 4);
    if (w !== shownWidth || h !== shownHeight) {
      shownWidth = w;
      shownHeight = h;
      if (canvas) {
        canvas.width = w;
        canvas.height = h;
      }
      pendingSize = { width: w, height: h };
    }
    if (canvas) {
      context2d ??= canvas.getContext('2d');
      if (!context2d) throw new Error('present: the canvas gave no 2D context');
      // The module's memory is never shared (wasm-binary.ts refuses a shared one), so its buffer is an ArrayBuffer.
      context2d.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer as ArrayBuffer, pixels.byteOffset, pixels.length), w, h), 0, 0);
    } else {
      // Sent once a frame, the last one presented.
      pendingPixels = { width: w, height: h, buffer: pixels.slice().buffer };
    }
  }

  function flushPixels(): void {
    if (pendingSize) {
      const sz = pendingSize;
      pendingSize = null;
      post({ type: 'size', width: sz.width, height: sz.height });
    }
    if (!pendingPixels) return;
    const frame = pendingPixels;
    pendingPixels = null;
    post({ type: 'pixels', width: frame.width, height: frame.height, buffer: frame.buffer }, [frame.buffer]);
  }

  /**
   * A table of functions a module may import, made with no prototype: a
   * module that imports `constructor` or `__proto__` finds nothing here and
   * gets the stub that stops it, never the worker's own Object.
   */
  function table<T>(entries: Record<string, T>): Record<string, T> {
    return Object.assign(Object.create(null) as Record<string, T>, entries);
  }

  const softn = table<(...args: never[]) => unknown>({
    present: (ptr: number, width: number, height: number) => present(ptr, width, height),
    log: (ptr: number, length: number) => {
      // A view, not a copy: the console keeps only what it shows.
      capture('out', region(ptr >>> 0, length >>> 0));
      capture('out', new Uint8Array([10]));
    },
    post: (ptr: number, length: number) => {
      const bytes = length >>> 0;
      if (++postsThisTurn > MAX_POSTS_PER_TURN) throw new Error(`post: more than ${MAX_POSTS_PER_TURN} messages in one turn`);
      if (bytes > MAX_POST_BYTES) throw new Error('post: a message is at most 1 MB');
      postBytesThisTurn += bytes;
      if (postBytesThisTurn > MAX_POST_BYTES_PER_TURN) throw new Error('post: more than 4 MB of messages in one turn');
      post({ type: 'post', text: readText(ptr >>> 0, bytes) });
    },
    audio: (ptr: number, frames: number) => {
      const count = frames >>> 0;
      if (count === 0) return;
      if (count > audioRate * 2) throw new Error('audio: at most two seconds of sound at a time');
      // A turn queues at most four seconds of sound, in at most 64 pieces; more is let go.
      audioFramesThisTurn += count;
      if (++audioPostsThisTurn > MAX_AUDIO_POSTS_PER_TURN || audioFramesThisTurn > audioRate * 4) return;
      const bytes = region(ptr >>> 0, count * 8);
      const samples = new Float32Array(count * 2);
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
      for (let i = 0; i < count * 2; i++) samples[i] = dv.getFloat32(i * 4, true);
      post({ type: 'audio', samples }, [samples.buffer]);
    },
    audio_rate: () => audioRate,
    audio_queued: () => audioQueued,
    now: () => performance.now() - t0,
  });

  // ------------------------------------ env: what Emscripten's standalone builds ask

  const env = table<(...args: never[]) => unknown>({
    emscripten_notify_memory_growth: () => undefined,
    emscripten_memcpy_js: (dest: number, src: number, count: number) => heap().copyWithin(dest >>> 0, src >>> 0, (src >>> 0) + (count >>> 0)),
    _emscripten_memcpy_js: (dest: number, src: number, count: number) => heap().copyWithin(dest >>> 0, src >>> 0, (src >>> 0) + (count >>> 0)),
    emscripten_memcpy_big: (dest: number, src: number, count: number) => heap().copyWithin(dest >>> 0, src >>> 0, (src >>> 0) + (count >>> 0)),
    emscripten_date_now: () => Date.now(),
    emscripten_get_now: () => performance.now(),
    _emscripten_get_now_is_monotonic: () => 1,
    emscripten_get_heap_max: () => Math.min(maxPages * 65536, 4294901760),
    emscripten_resize_heap: (requested: number) => {
      const mem = memory();
      const have = mem.buffer.byteLength / 65536;
      const want = Math.ceil((requested >>> 0) / 65536);
      if (want <= have) return 1;
      try {
        mem.grow(want - have);
        return 1;
      } catch {
        return 0;
      }
    },
    abort: () => {
      throw new Error('The module aborted');
    },
    _abort_js: () => {
      throw new Error('The module aborted');
    },
  });

  function stub(module: string, name: string): () => never {
    return () => {
      throw new Error(`The module called ${module}.${name}, which SoftN does not give a module`);
    };
  }

  function zeroOf(type: string): number | bigint | null {
    if (type === 'i64') return 0n;
    if (type === 'funcref' || type === 'externref') return null;
    return 0;
  }

  /** Everything the module imports, from what SoftN gives or made to fit. */
  function buildImports(list: WasmImport[]): WebAssembly.Imports {
    // No prototypes here either: an import named `__proto__` is an entry like any other.
    const imports = Object.create(null) as Record<string, Record<string, WebAssembly.ImportValue>>;
    missing = [];
    for (const entry of list) {
      imports[entry.module] ??= Object.create(null) as Record<string, WebAssembly.ImportValue>;
      let value: WebAssembly.ImportValue;
      if (entry.kind === 'function') {
        const given =
          entry.module === 'wasi_snapshot_preview1'
            ? wasi[entry.name] && guarded(wasi[entry.name])
            : entry.module === 'softn'
              ? softn[entry.name]
              : entry.module === 'env'
                ? env[entry.name]
                : undefined;
        if (given) {
          value = given as unknown as WebAssembly.ImportValue;
        } else {
          missing.push(`${entry.module}.${entry.name}`);
          value = stub(entry.module, entry.name);
        }
      } else if (entry.kind === 'memory') {
        // The host gives every memory and table import its ceiling (wasm-binary.ts cappedImports).
        const maximum = Math.min(entry.limits.max ?? maxPages, maxPages);
        const made = new WebAssembly.Memory({ initial: entry.limits.min, maximum });
        importedMemory ??= made;
        value = made;
      } else if (entry.kind === 'table') {
        const element = entry.element === 'externref' ? 'externref' : 'anyfunc';
        if (entry.limits.max === undefined) throw new Error(`The table ${entry.module}.${entry.name} was given no ceiling`);
        value = new WebAssembly.Table({ element: element as WebAssembly.TableKind, initial: entry.limits.min, maximum: entry.limits.max });
      } else if (entry.kind === 'global') {
        if (entry.type === 'v128' || entry.type === 'ref') throw new Error(`The module imports ${entry.module}.${entry.name}, a global of a type SoftN cannot make (${entry.type})`);
        const valueType = entry.type === 'funcref' ? 'anyfunc' : entry.type;
        value = new WebAssembly.Global({ value: valueType as WebAssembly.ValueType, mutable: entry.mutable }, zeroOf(entry.type) as number);
      } else {
        throw new Error(`The module imports ${entry.module}.${entry.name}, an exception tag, which SoftN cannot give it`);
      }
      imports[entry.module][entry.name] = value;
    }
    return imports;
  }

  // ------------------------------------------------------------------ calls

  /** A value as the parameter of `type` takes it: i64 as a BigInt, the rest as numbers. */
  function coerce(value: unknown, type: string | undefined): unknown {
    if (type === 'i64') {
      if (typeof value === 'bigint') return value;
      const n = Number(value ?? 0);
      if (!Number.isFinite(n)) throw new Error(`${String(value)} is no whole number for a 64-bit parameter`);
      return BigInt(Math.trunc(n));
    }
    if (type === 'i32') {
      const n = typeof value === 'bigint' ? Number(BigInt.asIntN(64, value)) : Number(value ?? 0);
      // The engine would make NaN or Infinity a silent 0.
      if (!Number.isFinite(n)) throw new Error(`${String(value)} is no whole number for a 32-bit parameter`);
      return n;
    }
    // A float parameter takes NaN and the infinities as they are.
    if (type === 'f32' || type === 'f64') return typeof value === 'bigint' ? Number(BigInt.asIntN(64, value)) : Number(value ?? 0);
    return value;
  }

  /** Calls an export with values made to fit its signature; undefined when it has no such function. */
  function invoke(name: string, values: unknown[]): unknown {
    const fn = exportsObj[name];
    if (typeof fn !== 'function') return undefined;
    const signature = signatures.get(name);
    const args = signature ? signature.params.map((type, i) => coerce(values[i], type)) : values;
    return (fn as (...a: unknown[]) => unknown)(...args);
  }

  /** Copies bytes into memory the module gives with its allocator; the pointer. */
  function allocate(bytes: Uint8Array, allocName: string | null): number {
    const names = allocName ? [allocName] : ['alloc', 'malloc'];
    const name = names.find((n) => typeof exportsObj[n] === 'function');
    if (!name) {
      throw new Error(
        allocName
          ? `The module exports no function "${allocName}" to give memory for a text or bytes argument`
          : 'A text or bytes argument is copied into memory the module gives: it must export alloc(size) or malloc(size), or the call names its allocator in options.alloc'
      );
    }
    const fn = exportsObj[name] as (...a: unknown[]) => unknown;
    const raw = fn.length >= 2 ? invoke(name, [bytes.length, 1]) : invoke(name, [bytes.length]);
    const ptr = Number(raw) >>> 0;
    if (ptr === 0 && bytes.length > 0) throw new Error(`${name}(${bytes.length}) gave no memory`);
    region(ptr, bytes.length).set(bytes);
    return ptr;
  }

  /** Where an answer is and how long: from one i64 (where << 32 | length) or two i32. */
  function located(result: unknown, returns: string): [number, number] {
    if (typeof result === 'bigint') return [Number((result >> 32n) & 0xffffffffn), Number(result & 0xffffffffn)];
    if (Array.isArray(result) && result.length === 2) return [Number(result[0]) >>> 0, Number(result[1]) >>> 0];
    throw new Error(
      `returns: "${returns}" reads the answer from where it is and how long it is: the function must give back one 64-bit number (where << 32 | length) or two 32-bit numbers`
    );
  }

  function asNumber(value: unknown): unknown {
    if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
    if (Array.isArray(value)) return value.map(asNumber);
    return value ?? null;
  }

  function freeAnswer(free: boolean | string, ptr: number, length: number): void {
    if (free === false) return;
    const name = typeof free === 'string' ? free : typeof exportsObj.dealloc === 'function' ? 'dealloc' : typeof exportsObj.free === 'function' ? 'free' : null;
    if (!name || typeof exportsObj[name] !== 'function') throw new Error('free: the module exports no dealloc(ptr, length) or free(ptr) to give the answer back to');
    const fn = exportsObj[name] as (...a: unknown[]) => unknown;
    invoke(name, fn.length >= 2 ? [ptr, length] : [ptr]);
  }

  function call(message: WasmCallMessage): unknown {
    if (exitedWith !== null) throw new Error(`The module has exited (code ${exitedWith}) and takes no more calls`);
    const fn = exportsObj[message.name];
    if (typeof fn !== 'function') {
      const names = Object.keys(exportsObj).filter((k) => typeof exportsObj[k] === 'function');
      throw new Error(`The module exports no function "${message.name}"${names.length ? `; it exports ${names.slice(0, 20).join(', ')}` : ''}`);
    }
    const values: unknown[] = [];
    for (const arg of message.args) {
      if (arg !== null && typeof arg === 'object' && 'text' in arg) {
        const bytes = encoder.encode(arg.text);
        values.push(allocate(bytes, message.alloc), bytes.length);
      } else if (arg !== null && typeof arg === 'object' && 'bytes' in arg) {
        values.push(allocate(arg.bytes, message.alloc), arg.bytes.length);
      } else {
        values.push(arg ?? 0);
      }
    }
    const signature = signatures.get(message.name);
    const params = signature ? signature.params.length : (fn as (...a: unknown[]) => unknown).length;
    if (values.length !== params) {
      throw new Error(
        `${message.name} takes ${params} number${params === 1 ? '' : 's'}; the call gave ${values.length}` +
          (message.args.some((a) => a !== null && typeof a === 'object') ? ' (a text or bytes argument is two: where it is and how long)' : '')
      );
    }
    const result = invoke(message.name, values);
    switch (message.returns) {
      case 'none':
        return null;
      case 'text':
      case 'json':
      case 'bytes': {
        const [ptr, length] = located(result, message.returns);
        if (length > MAX_WASM_RETURN_BYTES) {
          throw new Error(`${message.name} answered with ${length} bytes, exceeding the ${MAX_WASM_RETURN_BYTES}-byte limit`);
        }
        const bytes = region(ptr, length).slice();
        freeAnswer(message.free, ptr, length);
        if (message.returns === 'bytes') return bytes;
        const text = decoder.decode(bytes);
        if (message.returns === 'text') return text;
        try {
          return JSON.parse(text);
        } catch {
          throw new Error(`${message.name} answered with text that is not JSON: ${text.slice(0, 120)}`);
        }
      }
      case 'cstring': {
        const ptr = Number(result) >>> 0;
        const bytes = heap();
        const limit = Math.min(bytes.length, ptr + MAX_WASM_RETURN_BYTES + 1);
        let end = ptr;
        while (end < limit && bytes[end] !== 0) end++;
        if (end >= bytes.length) throw new Error(`${message.name} answered with a text that has no end (no 0 byte before the end of memory)`);
        if (bytes[end] !== 0) throw new Error(`${message.name} answered with a cstring exceeding the ${MAX_WASM_RETURN_BYTES}-byte limit`);
        const text = decoder.decode(bytes.subarray(ptr, end));
        freeAnswer(message.free, ptr, end - ptr + 1);
        return text;
      }
      default:
        return asNumber(result);
    }
  }

  const MAX_WASM_RETURN_BYTES = 16 * 1024 * 1024;
  const MAX_WASM_READ_ELEMENTS = 262_144;
  const SIZES = table<number>({ u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, f64: 8 });

  function read(message: WasmReadMessage): unknown {
    const ptr = message.ptr >>> 0;
    const length = message.length >>> 0;
    if (message.as === 'bytes') {
      if (length > MAX_WASM_RETURN_BYTES) throw new Error(`read: ${length} bytes exceeds the ${MAX_WASM_RETURN_BYTES}-byte limit`);
      return region(ptr, length).slice();
    }
    if (message.as === 'text') {
      if (length > MAX_WASM_RETURN_BYTES) throw new Error(`read: ${length} bytes exceeds the ${MAX_WASM_RETURN_BYTES}-byte limit`);
      return readText(ptr, length);
    }
    const size = SIZES[message.as];
    if (!size) throw new Error(`read: "${message.as}" is not one of bytes, text, u8, i8, u16, i16, u32, i32, f32, f64`);
    if (length > MAX_WASM_READ_ELEMENTS) {
      throw new Error(`read: ${length} elements exceeds the ${MAX_WASM_READ_ELEMENTS}-element limit`);
    }
    const bytes = region(ptr, length * size);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const out: Array<number | string> = new Array(length);
    for (let i = 0; i < length; i++) {
      const at = i * size;
      let val: number;
      switch (message.as) {
        case 'u8':
          val = dv.getUint8(at);
          break;
        case 'i8':
          val = dv.getInt8(at);
          break;
        case 'u16':
          val = dv.getUint16(at, true);
          break;
        case 'i16':
          val = dv.getInt16(at, true);
          break;
        case 'u32':
          val = dv.getUint32(at, true);
          break;
        case 'i32':
          val = dv.getInt32(at, true);
          break;
        case 'f32':
          val = dv.getFloat32(at, true);
          break;
        default:
          val = dv.getFloat64(at, true);
      }
      // NaN and the infinities as text, as a call's answer gives them: JSON would make them null.
      out[i] = Number.isFinite(val) ? val : String(val);
    }
    return out;
  }

  // --------------------------------------------------------------- a program

  function deliver(event: WasmInputEvent): void {
    switch (event.kind) {
      case 'key':
        invoke('key', [event.code, event.down ? 1 : 0]);
        break;
      case 'text':
        invoke('text', [event.codepoint]);
        break;
      case 'pointer':
        invoke('pointer', [event.id, event.phase, event.x, event.y, event.buttons]);
        break;
      case 'wheel':
        invoke('wheel', [event.dx, event.dy]);
        break;
      case 'resize':
        invoke('resize', [event.width, event.height]);
        break;
      case 'gamepad':
        invoke('gamepad', [event.index, event.buttons, ...event.axes.slice(0, 4)]);
        break;
    }
  }

  /**
   * Runs a step of the module: an exit is kept, and the turn's output shown.
   * A program's exit is told as an event once it has started; while it starts,
   * its start's answer says it (`ready`'s exitCode), and an exit(0) there may
   * still be no exit at all (a program that draws, see start).
   */
  function step(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      if (!isExit(error)) throw error;
      exitedWith = error.softnExit;
      if (mode === 'program' && !starting) post({ type: 'exit', code: exitedWith });
    } finally {
      endTurn();
    }
  }

  // ------------------------------------------------------------------ start

  async function start(message: WasmStartMessage): Promise<void> {
    starting = true;
    try {
      await startModule(message);
    } finally {
      starting = false;
    }
  }

  async function startModule(message: WasmStartMessage): Promise<void> {
    mode = message.mode;
    moduleName = message.name;
    maxPages = message.maxPages;
    maxOutput = message.maxOutputBytes;
    maxFileBytes = message.maxFileBytes;
    keepOutput = message.mode === 'run';
    showConsole = message.console;
    canvas = message.canvas;
    audioRate = message.audioRate;
    argv = [moduleName, ...message.args].map((a) => encoder.encode(a));
    environ = message.env.map((e) => encoder.encode(e));
    stdin = message.stdin ?? new Uint8Array(0);
    for (const file of message.files) addFile(file.path, file.bytes);
    fds.set(0, { kind: 'stdin' });
    fds.set(1, { kind: 'stdout' });
    fds.set(2, { kind: 'stderr' });
    // The folder of files, under the two names a C library or Rust's looks
    // for: the root, and the folder a relative path starts in.
    fds.set(3, { kind: 'dir', node: root, preopen: '/' });
    fds.set(4, { kind: 'dir', node: root, preopen: '.' });
    for (const entry of message.exports) if (entry.kind === 'function' && entry.type) signatures.set(entry.name, entry.type);

    startTurn();
    let instance: WebAssembly.Instance | null = null;
    try {
      instance = await WebAssembly.instantiate(message.module, buildImports(message.imports));
    } catch (error) {
      // A start function that calls exit ends the module before it has any exports.
      if (!isExit(error)) throw error;
      exitedWith = error.softnExit;
    }
    if (instance) exportsObj = instance.exports as Record<string, unknown>;

    if (mode === 'run') {
      let exitCode: number | null = exitedWith ?? 0;
      let error: string | null = null;
      const entry = exportsObj[message.entry];
      if (exitedWith !== null) {
        // It exited as it was started: its code is the run's.
      } else if (typeof entry !== 'function') {
        exitCode = null;
        error = `The module exports no "${message.entry}" to run. A command is built with a main function (for WASI, _start); a library's functions are called with softn.wasm.load and softn.wasm.call.`;
      } else {
        try {
          (entry as () => unknown)();
        } catch (thrown) {
          if (isExit(thrown)) exitCode = thrown.softnExit;
          else {
            exitCode = null;
            error = describe(thrown);
          }
        }
      }
      const files: { path: string; bytes: Uint8Array }[] = [];
      const walk = (dir: FsDir, prefix: string) => {
        for (const [name, node] of dir.entries) {
          if (node.dir) walk(node, `${prefix}${name}/`);
          else if (node.touched) files.push({ path: `${prefix}${name}`, bytes: node.data.slice(0, node.size) });
        }
      };
      walk(root, '');
      const stdout = joined(output.out);
      const stderr = joined(output.err);
      post(
        { type: 'done', id: message.id, exitCode, error, stdout, stderr, truncated, files },
        [stdout.buffer, stderr.buffer, ...files.map((f) => f.bytes.buffer)]
      );
      return;
    }

    if (exitedWith !== null) {
      // Exited as it was started; it takes no calls.
    } else if (typeof exportsObj._initialize === 'function') {
      step(() => invoke('_initialize', []));
    } else if (typeof exportsObj._start === 'function' && (message.start || mode === 'program')) {
      // A C program's main returns through exit(0): set up, and its frame
      // function is called from here on. Any other code ends it.
      step(() => invoke('_start', []));
      if (exitedWith === 0 && typeof exportsObj.frame === 'function') exitedWith = null;
      // A program with no frame has run once: a main that returned (wasi-libc's and Rust's
      // _start call no exit for 0) has finished as surely as one that called exit(0).
      else if (exitedWith === null && mode === 'program' && typeof exportsObj.frame !== 'function') exitedWith = 0;
    }
    endTurn();
    flushPixels();
    post({ type: 'ready', id: message.id, memoryPages: memoryPages(), missing, exitCode: exitedWith });
  }

  function memoryPages(): number {
    try {
      return memory().buffer.byteLength / 65536;
    } catch {
      return 0;
    }
  }

  // ---------------------------------------------------------------- messages

  async function handle(message: WasmWorkerRequest): Promise<void> {
    switch (message.type) {
      case 'start':
        await start(message);
        return;
      case 'call': {
        let value: unknown;
        startTurn();
        try {
          value = call(message);
        } catch (error) {
          if (isExit(error)) {
            exitedWith = error.softnExit;
            if (mode === 'program') post({ type: 'exit', code: exitedWith });
            endTurn();
            post({ type: 'error', id: message.id, message: `The module exited with code ${exitedWith}` });
            return;
          }
          endTurn();
          throw error;
        }
        endTurn();
        flushPixels();
        post({ type: 'result', id: message.id, value }, value instanceof Uint8Array ? [value.buffer] : []);
        return;
      }
      case 'read': {
        const value = read(message);
        post({ type: 'result', id: message.id, value }, value instanceof Uint8Array ? [value.buffer] : []);
        return;
      }
      case 'write': {
        region(message.ptr >>> 0, message.bytes.length).set(message.bytes);
        post({ type: 'result', id: message.id, value: message.bytes.length });
        return;
      }
      case 'frame': {
        audioQueued = message.audioQueued;
        startTurn();
        if (exitedWith === null) {
          step(() => {
            for (const event of message.events) deliver(event);
            invoke('frame', [message.time]);
          });
        }
        flushPixels();
        post({ type: 'framed', id: message.id });
        return;
      }
    }
  }

  let queue: Promise<void> = Promise.resolve();
  scope.onmessage = (event) => {
    const message = event.data as WasmWorkerRequest;
    queue = queue.then(
      () =>
        handle(message).catch((error: unknown) => {
          endTurn();
          post({ type: 'error', id: message.id, message: describe(error) });
        })
    );
  };
}
