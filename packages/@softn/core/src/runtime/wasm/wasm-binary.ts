/**
 * What a WebAssembly module's bytes say that the browser's own API does not,
 * and the limits written into them.
 *
 * `WebAssembly.Module.imports()` and `.exports()` give a name and a kind and
 * nothing else: not what a function takes and gives back, not how much
 * memory or how many table entries a module starts with or may grow to.
 * SoftN needs all of it before it runs a module an app hands it:
 *
 * - the limits of its memory and its tables, so a module is given no more
 *   than an app may use. `capWasmModule` writes the ceilings into the module
 *   itself, a `maximum` the engine enforces on every `memory.grow` and
 *   `table.grow`; `cappedImports` gives an imported memory or table the same.
 *   What cannot be held to a ceiling is refused, saying why
 *   (`checkRunnable`): a second memory, a memory shared between threads or
 *   indexed by 64-bit numbers, objects of the GC proposal (struct and array
 *   types, which the engine allocates outside any memory), exception
 *   references (exnref) kept in a table or a global or carried by an
 *   exception, where exceptions could pile up outside its memory the same
 *   way (on the stack, in locals and arguments, they are as bounded as the
 *   stack), an exception that carries more than a few values, and types this
 *   reader cannot read, where such objects could hide;
 * - what each import is, so the imports SoftN does not provide can still be
 *   given: a memory or a table of the size the module asks for, a function
 *   that stops the module, saying its name, if it is ever called;
 * - what each exported function takes, so a call from an app's logic can turn
 *   a text into the two numbers a function reads it from, and say plainly
 *   when the numbers do not fit.
 *
 * Only the sections that say these things are read (types, imports,
 * functions, tables, memories, tags, globals, exports); every other is
 * stepped over by its size.
 */

/**
 * A value a function takes or gives back. `exnref` is a reference to an
 * exception (the exception handling proposal); `ref` any other reference type
 * beyond funcref and externref.
 */
export type WasmValType = 'i32' | 'i64' | 'f32' | 'f64' | 'v128' | 'funcref' | 'externref' | 'exnref' | 'ref';

/** The most values an exception a module throws may carry: what a C++ or setjmp exception carries is one or two. */
export const MAX_EXCEPTION_VALUES = 8;

export interface WasmFuncType {
  params: WasmValType[];
  results: WasmValType[];
}

/** A memory's or a table's size: pages (64 KiB) for a memory, entries for a table. */
export interface WasmLimits {
  min: number;
  max?: number;
  /** Shared between threads: a module built for threads. */
  shared?: boolean;
  /** Indexed by 64-bit numbers (the memory64 proposal). */
  index64?: boolean;
}

export type WasmImport =
  | { module: string; name: string; kind: 'function'; type?: WasmFuncType }
  | { module: string; name: string; kind: 'memory'; limits: WasmLimits }
  | { module: string; name: string; kind: 'table'; element: WasmValType; limits: WasmLimits }
  | { module: string; name: string; kind: 'global'; type: WasmValType; mutable: boolean }
  | { module: string; name: string; kind: 'tag' };

export type WasmExternKind = 'function' | 'table' | 'memory' | 'global' | 'tag';

export interface WasmExport {
  name: string;
  kind: WasmExternKind;
  /** For a function, what it takes and gives back, when the types were read. */
  type?: WasmFuncType;
}

export interface WasmModuleInfo {
  imports: WasmImport[];
  exports: WasmExport[];
  /** The memories the module defines itself (an imported one is among `imports`). */
  memories: WasmLimits[];
  /** The tables the module defines itself. */
  tables: WasmLimits[];
  /** False where the types or a global's initial value use an encoding this reader does not know. */
  typesRead: boolean;
  /** Struct or array types of the GC proposal: objects the engine allocates outside any memory. */
  gcTypes: boolean;
  /** A table defined with an initial value (the typed function references proposal's form). */
  initialisedTables: boolean;
  /** Exception references (exnref) in a table or a global, or carried by an exception: where exceptions can be kept without end. */
  exceptionRefs: boolean;
  /** The most values one of its exceptions (its tags, its own and imported) carries; 0 for a module with none. */
  largestException: number;
}

/** The bytes are not a WebAssembly module this reader can follow, or one SoftN can run, with the reason in words. */
export class WasmFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WasmFormatError';
  }
}

/** A module's memory or tables would need more than an app may give it. */
export class WasmLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WasmLimitError';
  }
}

/** A WebAssembly page: memory grows and is limited in these. */
export const WASM_PAGE_BYTES = 65536;

/** What a module may grow to. */
export interface WasmCaps {
  /** Pages of memory. */
  maxPages: number;
  /** Table entries, every table together. */
  maxTableEntries: number;
}

const MAGIC = [0x00, 0x61, 0x73, 0x6d];
const KINDS: readonly WasmExternKind[] = ['function', 'table', 'memory', 'global', 'tag'];

/** Raised inside the type reader for an encoding it does not know; caught there. */
class UnknownType extends Error {}

/**
 * The heap types of the exception hierarchy, exn and noexn (the null
 * exception reference's): as the shorthand value type's byte, and as the
 * signed number a heap type is, however many bytes it is written in (an
 * engine takes `0xE9 0x7F` for -23 as well as `0x69`).
 */
const EXN = 0x69;
const NOEXN = 0x74;
const EXN_HEAP = -23;
const NOEXN_HEAP = -12;

/** What the readers found along the way that decides whether the module can be run. */
interface Found {
  gc: boolean;
  exn: boolean;
}

/** A cursor over the module's bytes. */
class Reader {
  pos: number;
  constructor(
    readonly bytes: Uint8Array,
    start = 0,
    readonly end = bytes.length
  ) {
    this.pos = start;
  }

  byte(): number {
    if (this.pos >= this.end) throw new WasmFormatError('The module ends in the middle of a section: it is cut short or is not WebAssembly.');
    return this.bytes[this.pos++];
  }

  /** An unsigned LEB128 number of up to `bits` bits, as a JavaScript number (exact to 2^53). */
  uleb(bits = 32): number {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < Math.ceil(bits / 7); i++) {
      const b = this.byte();
      result += (b & 0x7f) * scale;
      if ((b & 0x80) === 0) return result;
      scale *= 128;
    }
    throw new WasmFormatError('A number in the module is longer than its type allows.');
  }

  /**
   * A signed LEB128 number of up to `bits` bits (heap types are written as
   * s33), as a JavaScript number: exact for what a heap type or a type index
   * can be, which is all its value is read for.
   */
  sleb(bits = 33): number {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < Math.ceil(bits / 7); i++) {
      const b = this.byte();
      result += (b & 0x7f) * scale;
      scale *= 128;
      if ((b & 0x80) === 0) return b & 0x40 ? result - scale : result;
    }
    throw new WasmFormatError('A number in the module is longer than its type allows.');
  }

  name(): string {
    const length = this.uleb();
    if (this.pos + length > this.end) throw new WasmFormatError('A name in the module runs past the end of its section.');
    const text = new TextDecoder().decode(this.bytes.subarray(this.pos, this.pos + length));
    this.pos += length;
    return text;
  }

  limits(): WasmLimits {
    const flags = this.byte();
    if (flags > 0x07) throw new WasmFormatError(`The module gives a memory or table limit flag SoftN does not know (0x${flags.toString(16)}).`);
    const index64 = (flags & 0x04) !== 0;
    const bits = index64 ? 64 : 32;
    const limits: WasmLimits = { min: this.uleb(bits) };
    if (flags & 0x01) limits.max = this.uleb(bits);
    if (flags & 0x02) limits.shared = true;
    if (index64) limits.index64 = true;
    return limits;
  }
}

/** A value type, reading past any reference type's heap type. */
function valType(r: Reader): WasmValType {
  const b = r.byte();
  switch (b) {
    case 0x7f:
      return 'i32';
    case 0x7e:
      return 'i64';
    case 0x7d:
      return 'f32';
    case 0x7c:
      return 'f64';
    case 0x7b:
      return 'v128';
    case 0x70:
      return 'funcref';
    case 0x6f:
      return 'externref';
    case 0x63: // (ref null <heap type>)
    case 0x64: {
      // (ref <heap type>): an abstract heap type is a negative number, a type index one that is not.
      const heap = r.sleb();
      return heap === EXN_HEAP || heap === NOEXN_HEAP ? 'exnref' : 'ref';
    }
    default:
      // The abstract reference shorthands of the GC and exception proposals.
      if (b === EXN || b === NOEXN) return 'exnref';
      if ((b >= 0x6a && b <= 0x6e) || (b >= 0x71 && b <= 0x73)) return 'ref';
      throw new UnknownType();
  }
}

/** A composite type: a function type, or (`gc`) a struct or an array, which is no function. */
function compositeType(r: Reader, found: Found): WasmFuncType | null {
  const form = r.byte();
  if (form === 0x60) {
    // A function may take or give an exception reference: on the stack, it is as bounded as the
    // stack. An exception that carries one is not (tags, checked once they are read).
    const params = Array.from({ length: r.uleb() }, () => valType(r));
    const results = Array.from({ length: r.uleb() }, () => valType(r));
    return { params, results };
  }
  if (form === 0x5f) {
    found.gc = true;
    // struct: fields of a storage type and a mutability each.
    const fields = r.uleb();
    for (let i = 0; i < fields; i++) {
      storageType(r);
      r.byte();
    }
    return null;
  }
  if (form === 0x5e) {
    found.gc = true;
    storageType(r);
    r.byte();
    return null;
  }
  throw new UnknownType();
}

function storageType(r: Reader): void {
  const b = r.bytes[r.pos];
  // The packed types an array or a struct may hold (i8, i16).
  if (b === 0x78 || b === 0x77) {
    r.pos++;
    return;
  }
  valType(r);
}

/** One sub type of a rec group: its supertypes skipped, its composite type read. */
function subType(r: Reader, found: Found): WasmFuncType | null {
  const b = r.bytes[r.pos];
  if (b === 0x50 || b === 0x4f) {
    r.pos++;
    const supers = r.uleb();
    for (let i = 0; i < supers; i++) r.uleb();
  }
  return compositeType(r, found);
}

/** The type section: one entry per type index, null for a type that is no function. */
function readTypes(r: Reader, found: Found): (WasmFuncType | null)[] {
  const types: (WasmFuncType | null)[] = [];
  const count = r.uleb();
  for (let i = 0; i < count; i++) {
    if (r.bytes[r.pos] === 0x4e) {
      // A rec group: each of its sub types takes a type index of its own.
      r.pos++;
      const members = r.uleb();
      for (let j = 0; j < members; j++) types.push(subType(r, found));
    } else {
      types.push(subType(r, found));
    }
  }
  return types;
}

/** One table of the table section: its element type and limits, or null for the form with an initial value. */
function tableType(r: Reader): { element: WasmValType; limits: WasmLimits } | null {
  if (r.bytes[r.pos] === 0x40) return null;
  let element: WasmValType;
  try {
    element = valType(r);
  } catch (error) {
    if (error instanceof UnknownType) throw new WasmFormatError('A table of the module holds a kind of value SoftN does not know.');
    throw error;
  }
  return { element, limits: r.limits() };
}

/**
 * Steps over a constant expression (a global's initial value) to its `end`:
 * numbers, `global.get`, `ref.null`, `ref.func`, and the extended constants'
 * adds and multiplies. Anything else (a newer proposal's) is unknown here.
 */
function skipConstExpr(r: Reader): void {
  for (;;) {
    const op = r.byte();
    switch (op) {
      case 0x0b: // end
        return;
      case 0x41: // i32.const
        r.sleb(32);
        break;
      case 0x42: // i64.const
        r.sleb(64);
        break;
      case 0x43: // f32.const
        r.pos += 4;
        break;
      case 0x44: // f64.const
        r.pos += 8;
        break;
      case 0x23: // global.get
      case 0xd2: // ref.func
        r.uleb();
        break;
      case 0xd0: // ref.null <heap type>
        r.sleb();
        break;
      case 0x6a: // i32.add, sub, mul
      case 0x6b:
      case 0x6c:
      case 0x7c: // i64.add, sub, mul
      case 0x7d:
      case 0x7e:
        break;
      case 0xfd: {
        // v128.const
        if (r.uleb() !== 12) throw new UnknownType();
        r.pos += 16;
        break;
      }
      default:
        throw new UnknownType();
    }
  }
}

/** The global section: whether a global holds an exception reference. */
function readGlobals(r: Reader, found: Found): void {
  const count = r.uleb();
  for (let i = 0; i < count; i++) {
    if (valType(r) === 'exnref') found.exn = true;
    r.byte(); // mutability
    skipConstExpr(r);
  }
}

interface Section {
  id: number;
  /** Where its content starts and ends. */
  start: number;
  end: number;
  /** Where the section starts, its id byte. */
  headerStart: number;
}

/** The module's sections, checked for a WebAssembly header first. */
function sections(bytes: Uint8Array): Section[] {
  if (bytes.length < 8 || MAGIC.some((b, i) => bytes[i] !== b)) {
    throw new WasmFormatError('This is not a WebAssembly module: a .wasm file starts with the bytes "\\0asm".');
  }
  const version = bytes[4] | (bytes[5] << 8);
  const layer = bytes[6] | (bytes[7] << 8);
  if (layer === 1) {
    throw new WasmFormatError(
      'This is a WebAssembly component (the component model), not a core module. SoftN runs core modules: build for wasm32-unknown-unknown or wasm32-wasip1, or turn a component back into its core module.'
    );
  }
  if (version !== 1 || layer !== 0) throw new WasmFormatError(`This WebAssembly module is version ${version}; SoftN reads version 1.`);
  const found: Section[] = [];
  const r = new Reader(bytes, 8);
  while (r.pos < bytes.length) {
    const headerStart = r.pos;
    const id = r.byte();
    const size = r.uleb();
    const start = r.pos;
    const end = start + size;
    if (end > bytes.length) throw new WasmFormatError('A section of the module runs past its end: the file is cut short.');
    found.push({ id, start, end, headerStart });
    r.pos = end;
  }
  return found;
}

/**
 * What the module imports, exports and defines, with every function's
 * signature where the types could be read. Throws {@link WasmFormatError} for
 * bytes that are no module, or a version or layout it cannot follow.
 */
export function readWasmModule(input: Uint8Array | ArrayBuffer): WasmModuleInfo {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const imports: WasmImport[] = [];
  const exports: WasmExport[] = [];
  const memories: WasmLimits[] = [];
  const tables: WasmLimits[] = [];
  let types: (WasmFuncType | null)[] = [];
  let typesRead = true;
  let initialisedTables = false;
  const found: Found = { gc: false, exn: false };
  /** The type index of each function in the function index space: imported ones first. */
  const functionTypes: number[] = [];
  /** The type index of each tag (an exception's values), imported ones first. */
  const tagTypes: number[] = [];
  const exportIndexes: { name: string; kind: WasmExternKind; index: number }[] = [];
  /** Reads a part of the module whose types this reader may not know: such a module is refused (checkRunnable). */
  const readKnown = (read: () => void) => {
    try {
      read();
    } catch (error) {
      if (!(error instanceof UnknownType)) throw error;
      typesRead = false;
    }
  };

  for (const section of sections(bytes)) {
    const r = new Reader(bytes, section.start, section.end);
    switch (section.id) {
      case 1:
        try {
          types = readTypes(r, found);
        } catch (error) {
          if (!(error instanceof UnknownType)) throw error;
          types = [];
          typesRead = false;
        }
        break;
      case 2: {
        const count = r.uleb();
        for (let i = 0; i < count; i++) {
          const module = r.name();
          const name = r.name();
          const kind = r.byte();
          if (kind === 0x00) {
            const typeIndex = r.uleb();
            functionTypes.push(typeIndex);
            imports.push({ module, name, kind: 'function', type: types[typeIndex] ?? undefined });
          } else if (kind === 0x01) {
            const table = tableType(r);
            if (!table) throw new WasmFormatError(`The table "${module}.${name}" the module imports is of a form SoftN does not know.`);
            if (table.element === 'exnref') found.exn = true;
            imports.push({ module, name, kind: 'table', element: table.element, limits: table.limits });
          } else if (kind === 0x02) {
            imports.push({ module, name, kind: 'memory', limits: r.limits() });
          } else if (kind === 0x03) {
            let type: WasmValType;
            try {
              type = valType(r);
            } catch (error) {
              if (error instanceof UnknownType) throw new WasmFormatError(`The global "${module}.${name}" the module imports holds a kind of value SoftN does not know.`);
              throw error;
            }
            if (type === 'exnref') found.exn = true;
            imports.push({ module, name, kind: 'global', type, mutable: r.byte() === 0x01 });
          } else if (kind === 0x04) {
            r.byte(); // attribute: an exception
            tagTypes.push(r.uleb());
            imports.push({ module, name, kind: 'tag' });
          } else {
            throw new WasmFormatError(`The import "${module}.${name}" is of a kind SoftN does not know (0x${kind.toString(16)}).`);
          }
        }
        break;
      }
      case 3: {
        const count = r.uleb();
        for (let i = 0; i < count; i++) functionTypes.push(r.uleb());
        break;
      }
      case 4: {
        const count = r.uleb();
        for (let i = 0; i < count; i++) {
          const table = tableType(r);
          if (!table) {
            // Its initial value is an expression this reader does not step over: the rest of
            // the section is not read, and the module is refused (checkRunnable).
            initialisedTables = true;
            break;
          }
          if (table.element === 'exnref') found.exn = true;
          tables.push(table.limits);
        }
        break;
      }
      case 5: {
        const count = r.uleb();
        for (let i = 0; i < count; i++) memories.push(r.limits());
        break;
      }
      case 6:
        readKnown(() => readGlobals(r, found));
        break;
      case 13: {
        // Tags: an attribute (an exception) and the type of the values it carries.
        const count = r.uleb();
        for (let i = 0; i < count; i++) {
          r.byte();
          tagTypes.push(r.uleb());
        }
        break;
      }
      case 7: {
        const count = r.uleb();
        for (let i = 0; i < count; i++) {
          const name = r.name();
          const kindByte = r.byte();
          const index = r.uleb();
          const kind = KINDS[kindByte];
          if (!kind) throw new WasmFormatError(`The export "${name}" is of a kind SoftN does not know (0x${kindByte.toString(16)}).`);
          exportIndexes.push({ name, kind, index });
        }
        break;
      }
      default:
        break;
    }
  }

  // The type section precedes the imports in every valid module, so an
  // imported function's signature was known when it was read; an exported
  // one's is looked up through the function index space now.
  for (const { name, kind, index } of exportIndexes) {
    const entry: WasmExport = { name, kind };
    if (kind === 'function' && typesRead) {
      const type = types[functionTypes[index]];
      if (type) entry.type = type;
    }
    exports.push(entry);
  }
  const largestException = tagTypes.reduce((most, index) => Math.max(most, types[index]?.params.length ?? 0), 0);
  // An exception that carries an exception: a chain of them, as long as a module likes.
  if (tagTypes.some((index) => types[index]?.params.includes('exnref'))) found.exn = true;
  return { imports, exports, memories, tables, typesRead, gcTypes: found.gc, initialisedTables, exceptionRefs: found.exn, largestException };
}

function encodeUleb(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  do {
    let byte = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    out.push(byte);
  } while (rest > 0);
  return out;
}

/** Pages as megabytes, for messages: 16 pages is "1 MB". */
export function pagesToMB(pages: number): string {
  const mb = (pages * WASM_PAGE_BYTES) / (1024 * 1024);
  return Number.isInteger(mb) ? String(mb) : mb.toFixed(1);
}

/** Refuses a memory SoftN cannot run, saying why. */
function checkMemory(limits: WasmLimits, what: string): void {
  if (limits.shared) {
    throw new WasmFormatError(`The module's ${what} is shared between threads: it was built for threads, which SoftN does not run. Build it without threads (no -pthread, no atomics).`);
  }
  if (limits.index64) {
    throw new WasmFormatError(`The module's ${what} is indexed by 64-bit numbers (memory64), which SoftN does not run. Build it for wasm32.`);
  }
}

/**
 * Refuses, saying why, a module that could not be held to an app's limits:
 * more than one memory, a shared or 64-bit memory, objects of the GC
 * proposal, exception references kept in a table or a global or carried by
 * an exception, an exception carrying more than {@link MAX_EXCEPTION_VALUES}
 * values, types this reader cannot read, a table of a form it cannot
 * rewrite, a table indexed by 64-bit numbers.
 */
export function checkRunnable(info: WasmModuleInfo): void {
  const importedMemories = info.imports.filter((i): i is Extract<WasmImport, { kind: 'memory' }> => i.kind === 'memory');
  const memoryCount = importedMemories.length + info.memories.length;
  if (memoryCount > 1) {
    throw new WasmFormatError(`The module has ${memoryCount} memories; SoftN runs a module with one, so that it can be held to its limit.`);
  }
  for (const entry of importedMemories) checkMemory(entry.limits, `memory ${entry.module}.${entry.name}`);
  for (const limits of info.memories) checkMemory(limits, 'memory');
  if (!info.typesRead) {
    throw new WasmFormatError('The module uses types SoftN cannot read yet, so it cannot be held to an app\'s limits. Build it without newer proposals (GC, typed function references).');
  }
  if (info.gcTypes) {
    throw new WasmFormatError('The module uses WebAssembly GC (struct and array types), whose objects live outside its memory, where SoftN cannot hold them to a limit. Build it to keep its data in linear memory.');
  }
  if (info.exceptionRefs) {
    throw new WasmFormatError(
      'The module keeps exception references (exnref) in a table or a global, or throws exceptions that carry one: exceptions kept so live outside its memory, where SoftN cannot hold them to a limit. Keep them in locals, or build it without exceptions.'
    );
  }
  if (info.largestException > MAX_EXCEPTION_VALUES) {
    throw new WasmFormatError(`An exception of the module carries ${info.largestException} values; SoftN runs modules whose exceptions carry at most ${MAX_EXCEPTION_VALUES}, so that exceptions in flight stay small.`);
  }
  if (info.initialisedTables) {
    throw new WasmFormatError('The module defines a table with an initial value (typed function references), a form SoftN does not run yet.');
  }
  for (const entry of info.imports) {
    if (entry.kind === 'table' && entry.limits.index64) throw new WasmFormatError(`The module's table ${entry.module}.${entry.name} is indexed by 64-bit numbers, which SoftN does not run.`);
  }
  for (const limits of info.tables) {
    if (limits.index64) throw new WasmFormatError('A table of the module is indexed by 64-bit numbers, which SoftN does not run.');
  }
}

/**
 * Each table's maximum within the entries a module may have in all, its
 * imported tables first and then its own, in the order of the table index
 * space: its own maximum where that is smaller, else its start and an even
 * share of what the starts leave.
 */
function tableMaxima(tables: WasmLimits[], budget: number): number[] {
  const starts = tables.reduce((sum, t) => sum + t.min, 0);
  if (starts > budget) {
    throw new WasmLimitError(`The module's tables start with ${starts} entries, more than the ${budget} a module may have.`);
  }
  const share = tables.length > 0 ? Math.floor((budget - starts) / tables.length) : 0;
  return tables.map((t) => Math.min(t.max ?? Number.MAX_SAFE_INTEGER, t.min + share));
}

/**
 * The module's imports with the ceilings an imported memory or table is made
 * with: the memory's maximum within `caps.maxPages`, each table's within its
 * share of `caps.maxTableEntries`. Throws {@link WasmLimitError} for one that
 * starts larger than it may grow.
 */
export function cappedImports(info: WasmModuleInfo, caps: WasmCaps): WasmImport[] {
  const importedTables = info.imports.filter((i): i is Extract<WasmImport, { kind: 'table' }> => i.kind === 'table');
  const maxima = tableMaxima([...importedTables.map((t) => t.limits), ...info.tables], caps.maxTableEntries);
  let table = 0;
  return info.imports.map((entry) => {
    if (entry.kind === 'memory') {
      if (entry.limits.min > caps.maxPages) {
        throw new WasmLimitError(`The module asks for ${pagesToMB(entry.limits.min)} MB of memory to start with, more than the ${pagesToMB(caps.maxPages)} MB it may use.`);
      }
      return { ...entry, limits: { ...entry.limits, max: Math.min(entry.limits.max ?? caps.maxPages, caps.maxPages) } };
    }
    if (entry.kind === 'table') return { ...entry, limits: { ...entry.limits, max: maxima[table++] } };
    return entry;
  });
}

/**
 * The module with its own memory limited to `caps.maxPages` and each of its
 * own tables to its share of `caps.maxTableEntries` (see {@link tableMaxima}):
 * its own maximum where that is smaller, the ceiling where it gives none or a
 * larger one. The engine then refuses each `memory.grow` and `table.grow`
 * past it, as it would the module's own limit, and the module's allocator
 * reports an ordinary out of memory. Everything else in the module is copied
 * as it is.
 *
 * Call {@link checkRunnable} first: this throws {@link WasmLimitError} for a
 * memory or tables that start larger than they may grow, and does not check
 * the rest.
 */
export function capWasmModule(input: Uint8Array | ArrayBuffer, caps: WasmCaps): Uint8Array {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const found = sections(bytes);
  const info = readWasmModule(bytes);
  const importedTables = info.imports.filter((i): i is Extract<WasmImport, { kind: 'table' }> => i.kind === 'table');
  const maxima = tableMaxima([...importedTables.map((t) => t.limits), ...info.tables], caps.maxTableEntries).slice(importedTables.length);
  const rewritten = new Map<Section, number[]>();

  const memory = found.find((s) => s.id === 5);
  if (memory) {
    const r = new Reader(bytes, memory.start, memory.end);
    const count = r.uleb();
    const content: number[] = encodeUleb(count);
    for (let i = 0; i < count; i++) {
      const limits = r.limits();
      checkMemory(limits, 'memory');
      if (limits.min > caps.maxPages) {
        throw new WasmLimitError(`The module starts with ${pagesToMB(limits.min)} MB of memory, more than the ${pagesToMB(caps.maxPages)} MB it may use.`);
      }
      const max = Math.min(limits.max ?? caps.maxPages, caps.maxPages);
      content.push(0x01, ...encodeUleb(limits.min), ...encodeUleb(max));
    }
    rewritten.set(memory, content);
  }

  // With no ceiling on entries (capWasmMemory), the tables are left as they are.
  const table = found.find((s) => s.id === 4);
  if (table && !info.initialisedTables && Number.isFinite(caps.maxTableEntries)) {
    const r = new Reader(bytes, table.start, table.end);
    const count = r.uleb();
    const content: number[] = encodeUleb(count);
    for (let i = 0; i < count; i++) {
      // The element type as it is written, then the limits: the start and the table's share.
      const elementStart = r.pos;
      try {
        valType(r);
      } catch (error) {
        if (error instanceof UnknownType) throw new WasmFormatError('A table of the module holds a kind of value SoftN does not know.');
        throw error;
      }
      const elementEnd = r.pos;
      const limits = r.limits();
      for (let b = elementStart; b < elementEnd; b++) content.push(bytes[b]);
      content.push(0x01, ...encodeUleb(limits.min), ...encodeUleb(maxima[i]));
    }
    rewritten.set(table, content);
  }

  if (rewritten.size === 0) return bytes;
  // Slices of the module as it is, and the rewritten sections between them.
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const section of found) {
    const content = rewritten.get(section);
    if (!content) continue;
    parts.push(bytes.subarray(at, section.headerStart));
    parts.push(Uint8Array.from([section.id, ...encodeUleb(content.length), ...content]));
    at = section.end;
  }
  parts.push(bytes.subarray(at));
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The module with its memory limited to `maxPages` and its tables left as they are: {@link capWasmModule}. */
export function capWasmMemory(input: Uint8Array | ArrayBuffer, maxPages: number): Uint8Array {
  return capWasmModule(input, { maxPages, maxTableEntries: Infinity });
}

/** Whether a module is a command (`_start`), a reactor (`_initialize`) or a plain library. */
export function moduleKind(info: WasmModuleInfo): 'command' | 'reactor' | 'library' {
  const names = new Set(info.exports.filter((e) => e.kind === 'function').map((e) => e.name));
  if (names.has('_start')) return 'command';
  if (names.has('_initialize')) return 'reactor';
  return 'library';
}
