/**
 * A WebAssembly module written byte by byte, for the cases a compiler does
 * not make on request: an imported memory, a table, a global, a shared
 * memory, a function that takes 64-bit numbers and gives back two values.
 */

export type BuildVal = 'i32' | 'i64' | 'f32' | 'f64' | 'funcref' | 'externref' | 'exnref';

const VAL: Record<BuildVal, number> = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, funcref: 0x70, externref: 0x6f, exnref: 0x69 };

export type BuildImport =
  | { module: string; name: string; kind: 'func'; type: number }
  | { module: string; name: string; kind: 'memory'; min: number; max?: number; shared?: boolean }
  | { module: string; name: string; kind: 'table'; min: number; max?: number; element?: 'funcref' | 'externref' }
  | { module: string; name: string; kind: 'global'; type: BuildVal; mutable?: boolean };

export interface BuildSpec {
  types?: { params: BuildVal[]; results: BuildVal[] }[];
  /** The type section's content as it is, in place of `types` (for encodings this builder does not write). */
  typesRaw?: number[];
  imports?: BuildImport[];
  /** Each function's type and code; `end` is added. */
  funcs?: { type: number; locals?: BuildVal[]; code: number[] }[];
  tables?: { min: number; max?: number; element?: 'funcref' | 'externref' | 'exnref' }[];
  /** Tags (exceptions), each the type of the values it carries; written in their place, before the exports. */
  tags?: number[];
  /** Globals, each a type, mutability and an i32 or null-reference initial value. */
  globals?: { type: BuildVal; mutable?: boolean }[];
  memory?: { min: number; max?: number; shared?: boolean };
  /** More memories than one (the multi-memory proposal), in place of `memory`. */
  memories?: { min: number; max?: number; shared?: boolean }[];
  exports?: { name: string; kind: 'func' | 'table' | 'memory' | 'global'; index: number }[];
  /** The function run as the module is instantiated. */
  start?: number;
  /** Sections written as they are, after the rest: [id, content]. */
  raw?: [number, number[]][];
  /** The 4 version bytes; [1, 0, 0, 0] for a core module. */
  version?: number[];
}

export function uleb(value: number): number[] {
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

export function sleb(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  for (;;) {
    const byte = rest & 0x7f;
    rest >>= 7;
    if ((rest === 0 && (byte & 0x40) === 0) || (rest === -1 && (byte & 0x40) !== 0)) {
      out.push(byte);
      return out;
    }
    out.push(byte | 0x80);
  }
}

function name(text: string): number[] {
  const bytes = [...new TextEncoder().encode(text)];
  return [...uleb(bytes.length), ...bytes];
}

function vec(items: number[][]): number[] {
  return [...uleb(items.length), ...items.flat()];
}

function section(id: number, content: number[]): number[] {
  return [id, ...uleb(content.length), ...content];
}

function limits(min: number, max?: number, shared?: boolean): number[] {
  const flags = (max !== undefined ? 1 : 0) | (shared ? 2 : 0);
  return [flags, ...uleb(min), ...(max !== undefined ? uleb(max) : [])];
}

const KIND = { func: 0, table: 1, memory: 2, global: 3 } as const;

export function buildModule(spec: BuildSpec): Uint8Array {
  const out: number[] = [0x00, 0x61, 0x73, 0x6d, ...(spec.version ?? [1, 0, 0, 0])];
  if (spec.typesRaw) {
    out.push(...section(1, spec.typesRaw));
  } else if (spec.types?.length) {
    out.push(...section(1, vec(spec.types.map((t) => [0x60, ...vec(t.params.map((p) => [VAL[p]])), ...vec(t.results.map((r) => [VAL[r]]))]))));
  }
  if (spec.imports?.length) {
    out.push(
      ...section(
        2,
        vec(
          spec.imports.map((i) => {
            const head = [...name(i.module), ...name(i.name), KIND[i.kind]];
            switch (i.kind) {
              case 'func':
                return [...head, ...uleb(i.type)];
              case 'memory':
                return [...head, ...limits(i.min, i.max, i.shared)];
              case 'table':
                return [...head, VAL[i.element ?? 'funcref'], ...limits(i.min, i.max)];
              case 'global':
                return [...head, VAL[i.type], i.mutable ? 1 : 0];
            }
          })
        )
      )
    );
  }
  if (spec.funcs?.length) out.push(...section(3, vec(spec.funcs.map((f) => uleb(f.type)))));
  if (spec.tables?.length) out.push(...section(4, vec(spec.tables.map((t) => [VAL[t.element ?? 'funcref'], ...limits(t.min, t.max)]))));
  const memories = spec.memories ?? (spec.memory ? [spec.memory] : []);
  if (memories.length) out.push(...section(5, vec(memories.map((m) => limits(m.min, m.max, m.shared)))));
  if (spec.tags?.length) out.push(...section(13, vec(spec.tags.map((type) => [0x00, ...uleb(type)]))));
  if (spec.globals?.length) {
    // A number starts at 0; a reference starts null (ref.null of its own heap type).
    const init = (type: BuildVal) =>
      type === 'i32' ? [0x41, 0x00] : type === 'i64' ? [0x42, 0x00] : type === 'f32' ? [0x43, 0, 0, 0, 0] : type === 'f64' ? [0x44, 0, 0, 0, 0, 0, 0, 0, 0] : [0xd0, VAL[type]];
    out.push(...section(6, vec(spec.globals.map((g) => [VAL[g.type], g.mutable ? 1 : 0, ...init(g.type), 0x0b]))));
  }
  if (spec.exports?.length) out.push(...section(7, vec(spec.exports.map((e) => [...name(e.name), KIND[e.kind], ...uleb(e.index)]))));
  if (spec.start !== undefined) out.push(...section(8, uleb(spec.start)));
  if (spec.funcs?.length) {
    out.push(
      ...section(
        10,
        vec(
          spec.funcs.map((f) => {
            const body = [...vec((f.locals ?? []).map((l) => [1, VAL[l]])), ...f.code, 0x0b];
            return [...uleb(body.length), ...body];
          })
        )
      )
    );
  }
  for (const [id, content] of spec.raw ?? []) out.push(...section(id, content));
  return new Uint8Array(out);
}

/** A few instructions, by name, for the code above. */
export const op = {
  localGet: (i: number) => [0x20, ...uleb(i)],
  localSet: (i: number) => [0x21, ...uleb(i)],
  i32Const: (n: number) => [0x41, ...sleb(n)],
  i64Const: (n: number) => [0x42, ...sleb(n)],
  call: (i: number) => [0x10, ...uleb(i)],
  i32Add: [0x6a],
  i64Add: [0x7c],
  f64Sub: [0xa1],
  f64Lt: [0x63],
  drop: [0x1a],
  unreachable: [0x00],
  memorySize: [0x3f, 0x00],
  memoryGrow: [0x40, 0x00],
  /** table.grow on table `t`: takes (an initial reference, n) and gives the old size or -1. */
  tableGrow: (t: number) => [0xfc, 0x0f, ...uleb(t)],
  refNullFunc: [0xd0, 0x70],
  /** loop … br_if 0 … end: the body runs again while the condition before br_if is true. */
  loop: (body: number[]) => [0x03, 0x40, ...body, 0x0b],
  brIf: (depth: number) => [0x0d, ...uleb(depth)],
};

/** WASI preview1 functions by their types, for {@link wasiPassThrough}. */
export const WASI_TYPES: Record<string, { params: BuildVal[]; results: BuildVal[] }> = {
  path_open: { params: ['i32', 'i32', 'i32', 'i32', 'i32', 'i64', 'i64', 'i32', 'i32'], results: ['i32'] },
  path_unlink_file: { params: ['i32', 'i32', 'i32'], results: ['i32'] },
  path_create_directory: { params: ['i32', 'i32', 'i32'], results: ['i32'] },
  path_remove_directory: { params: ['i32', 'i32', 'i32'], results: ['i32'] },
  fd_close: { params: ['i32'], results: ['i32'] },
  fd_allocate: { params: ['i32', 'i64', 'i64'], results: ['i32'] },
  fd_filestat_set_size: { params: ['i32', 'i64'], results: ['i32'] },
  fd_filestat_get: { params: ['i32', 'i32'], results: ['i32'] },
  fd_renumber: { params: ['i32', 'i32'], results: ['i32'] },
  fd_pread: { params: ['i32', 'i32', 'i32', 'i64', 'i32'], results: ['i32'] },
  fd_readdir: { params: ['i32', 'i32', 'i32', 'i64', 'i32'], results: ['i32'] },
  fd_write: { params: ['i32', 'i32', 'i32', 'i32'], results: ['i32'] },
  fd_fdstat_get: { params: ['i32', 'i32'], results: ['i32'] },
};

/**
 * A module that exports each WASI function named, under its own name, passing
 * its numbers straight through to the import: a test drives the worker's WASI
 * by calling them, with paths and buffers written into the module's memory
 * (one exported memory of `pages` pages).
 */
export function wasiPassThrough(names: string[], pages = 4): Uint8Array {
  const types = names.map((n) => WASI_TYPES[n]);
  return buildModule({
    types,
    imports: names.map((n, i) => ({ module: 'wasi_snapshot_preview1', name: n, kind: 'func' as const, type: i })),
    funcs: names.map((_, i) => ({ type: i, code: [...types[i].params.flatMap((__, p) => op.localGet(p)), ...op.call(i)] })),
    memory: { min: pages },
    exports: [...names.map((n, i) => ({ name: n, kind: 'func' as const, index: names.length + i })), { name: 'memory', kind: 'memory' as const, index: 0 }],
  });
}
