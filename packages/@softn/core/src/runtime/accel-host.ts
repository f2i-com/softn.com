/**
 * The host side of zipp's `accel` bridge: compile numeric functions a script
 * generates with the host's own JavaScript engine, and run them over views of
 * the script's typed arrays.
 *
 * A script that generates code at run time (SoftDOS's x86 trace compiler is
 * the motivating one) is limited by the interpreter that runs the generated
 * code: zipp executes a bytecode operation in about five nanoseconds, so a
 * generated trace of a few thousand operations runs at a few hundred
 * thousand calls a second. The host's engine compiles the same source to
 * machine code. The bridge lets the script hand such a function over and get
 * back a handle it can run, with the script's own typed arrays bound as views
 * over the engine's linear memory, so the compiled code reads and writes the
 * same bytes the script does.
 *
 * What keeps this safe:
 *
 * - The source is parsed against a closed language (accel-source.ts), and
 *   what `new Function` compiles is text re-emitted from that parse, never
 *   the script's own: names must resolve to parameters or locals in scope,
 *   the only member access is `Math.<pure>(…)`, there are no string,
 *   template, regular-expression, array or object literals, no `new`, `this`,
 *   `arguments`, `typeof`, `in` or `instanceof`, and every computed key is
 *   forced to a number. A function that passes can name nothing outside its
 *   parameters and locals and can read no named property of anything, so it
 *   cannot reach the worker's globals.
 * - The views are bounded by the arrays the engine resolved: the engine
 *   answers a region only for a global holding a typed array, pins its buffer
 *   (never freed, resized or detached while the VM lives), and the view's
 *   length is that array's length. Indexing past a view reads `undefined` and
 *   writes nothing, as in any typed array.
 * - Callbacks into the script go through the engine's re-entry export with
 *   numbers only, and only while an `accel.run` call is in progress.
 * - The function runs without an instruction budget; a runaway one is a
 *   runaway worker, which the supervisor's deadline handles as it handles any
 *   other.
 *
 * The bridge is granted per app through its permission manifest.
 */

import { AccelValidationError, compileAccelSource, validateAccelSource } from './accel-source';

export { AccelValidationError, compileAccelSource, validateAccelSource };

const VIEW_CTORS: Array<
  | Int8ArrayConstructor
  | Uint8ArrayConstructor
  | Uint8ClampedArrayConstructor
  | Int16ArrayConstructor
  | Uint16ArrayConstructor
  | Int32ArrayConstructor
  | Uint32ArrayConstructor
  | Float32ArrayConstructor
  | Float64ArrayConstructor
> = [
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
];

type Region = { ptr: number; len: number; kind: number };

type Binding =
  | { kind: 'region'; region: Region }
  | { kind: 'callback'; name: string }
  | { kind: 'accel'; id: number }
  | { kind: 'table' }
  | { kind: 'number'; value: number };

type Compiled = {
  /** The function `new Function` produced, or the one a `make` returned. */
  fn: (...args: unknown[]) => unknown;
  params: string[];
  /** Set on a made function: what it was made from, to remake it after growth. */
  madeFrom?: { outer: number; bindings: Binding[] };
};

/**
 * Create the bridge object for `Engine.setAccelBridge`.
 *
 * `memory` is the engine's linear memory (`wasm.memory` from the glue);
 * `guestCall` is the glue's `accelGuestCall`, valid only during `run`.
 */
export function createAccelHost(opts: {
  /** The engine's linear memory, read at each use: it exists only once the module is instantiated. */
  memory: () => WebAssembly.Memory;
  guestCall: (name: string, args: Float64Array) => number;
  /** Bound on compiled functions kept alive; further compiles throw. */
  maxFunctions?: number;
}): {
  compile: (paramsJson: string, body: string) => number;
  make: (id: number, spec: string) => number;
  state: (ptr: number, len: number, kind: number) => void;
  run: (id: number, h: number) => number;
  install: (slot: number, id: number) => void;
} {
  const memory = { get buffer(): ArrayBuffer { return opts.memory().buffer; } };
  const guestCall = opts.guestCall;
  const maxFunctions = opts.maxFunctions ?? 65536;
  const fns: Compiled[] = [];
  const table: Array<((...a: unknown[]) => unknown) | null> = [];
  const tableIds: number[] = [];
  let stateRegion: Region | null = null;
  let stateView: ArrayBufferView | null = null;
  let boundBuffer: ArrayBuffer | null = null;

  const viewFor = (r: Region): ArrayBufferView => {
    const C = VIEW_CTORS[r.kind];
    if (!C) throw new Error(`accel: unknown element kind ${r.kind}`);
    return new C(memory.buffer, r.ptr, r.len);
  };

  const parseSpec = (spec: string): Map<string, Binding> => {
    const out = new Map<string, Binding>();
    if (spec === '') return out;
    for (const entry of spec.split(',')) {
      const eq = entry.indexOf('=');
      if (eq < 0) throw new Error(`accel: bad spec entry ${JSON.stringify(entry)}`);
      const name = entry.slice(0, eq);
      const rest = entry.slice(eq + 1);
      const colon = rest.indexOf(':');
      const tag = colon < 0 ? rest : rest.slice(0, colon);
      const value = colon < 0 ? '' : rest.slice(colon + 1);
      let b: Binding;
      if (tag === 'r') {
        const [ptr, len, kind] = value.split(':').map(Number);
        if (![ptr, len, kind].every(Number.isInteger)) throw new Error(`accel: bad region ${JSON.stringify(entry)}`);
        b = { kind: 'region', region: { ptr, len, kind } };
      } else if (tag === 'c') {
        if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) throw new Error(`accel: bad callback ${JSON.stringify(entry)}`);
        b = { kind: 'callback', name: value };
      } else if (tag === 'a') {
        const id = Number(value);
        if (!fns[id]) throw new Error(`accel: no function ${value}`);
        b = { kind: 'accel', id };
      } else if (tag === 't') {
        b = { kind: 'table' };
      } else if (tag === 'n') {
        b = { kind: 'number', value: Number(value) };
      } else {
        throw new Error(`accel: bad spec entry ${JSON.stringify(entry)}`);
      }
      out.set(name, b);
    }
    return out;
  };

  const realize = (b: Binding): unknown => {
    switch (b.kind) {
      case 'region':
        return viewFor(b.region);
      case 'callback': {
        const name = b.name;
        return (...a: number[]) => guestCall(name, Float64Array.from(a));
      }
      case 'accel':
        return fns[b.id].fn;
      case 'table':
        return table;
      case 'number':
        return b.value;
    }
  };

  const remakeAll = (): void => {
    // The buffer changed (memory grew): every view is detached. Rebuild the
    // made functions from their outers with fresh views, in creation order so
    // a function made from another made one sees the new one.
    for (let id = 0; id < fns.length; id++) {
      const c = fns[id];
      if (!c.madeFrom) continue;
      const args = c.madeFrom.bindings.map(realize);
      const made = fns[c.madeFrom.outer].fn(...args);
      if (typeof made !== 'function') throw new Error('accel: remade function is not a function');
      c.fn = made as Compiled['fn'];
    }
    for (let slot = 0; slot < tableIds.length; slot++) {
      const id = tableIds[slot];
      if (id >= 0 && fns[id]) table[slot] = fns[id].fn;
    }
    stateView = stateRegion ? viewFor(stateRegion) : null;
    boundBuffer = memory.buffer;
  };

  return {
    compile(paramsJson: string, body: string): number {
      if (fns.length >= maxFunctions) throw new Error('accel: too many functions');
      const params = JSON.parse(paramsJson) as unknown;
      if (!Array.isArray(params) || !params.every((p) => typeof p === 'string')) {
        throw new Error('accel: parameters must be an array of names');
      }
      // What compiles is the validator's re-emission of the body, not the
      // body: nothing the parse did not accept can reach the engine.
      const source = compileAccelSource(params as string[], body);
      // Strict mode: an assignment the validator somehow let through cannot
      // create a global, and `this` is undefined.
      const fn = new Function(...(params as string[]), '"use strict";' + source) as Compiled['fn'];
      fns.push({ fn, params: params as string[] });
      return fns.length - 1;
    },
    make(id: number, spec: string): number {
      const outer = fns[id];
      if (!outer) throw new Error(`accel: no function ${id}`);
      if (fns.length >= maxFunctions) throw new Error('accel: too many functions');
      const specMap = parseSpec(spec);
      const bindings: Binding[] = outer.params.map((p) => {
        const b = specMap.get(p);
        if (!b) throw new Error(`accel: spec does not bind ${p}`);
        return b;
      });
      if (memory.buffer !== boundBuffer) remakeAll();
      const made = outer.fn(...bindings.map(realize));
      if (typeof made !== 'function') throw new Error('accel: the function did not return a function');
      fns.push({ fn: made as Compiled['fn'], params: [], madeFrom: { outer: id, bindings } });
      return fns.length - 1;
    },
    state(ptr: number, len: number, kind: number): void {
      stateRegion = { ptr, len, kind };
      stateView = viewFor(stateRegion);
      boundBuffer = memory.buffer;
    },
    run(id: number, h: number): number {
      const c = fns[id];
      if (!c) throw new Error(`accel: no function ${id}`);
      if (memory.buffer !== boundBuffer) remakeAll();
      const r = c.fn(stateView, h);
      return typeof r === 'number' ? r : Number(r);
    },
    install(slot: number, id: number): void {
      if (!Number.isInteger(slot) || slot < 0 || slot > 1 << 20) throw new Error('accel: bad slot');
      if (!fns[id]) throw new Error(`accel: no function ${id}`);
      table[slot] = fns[id].fn;
      tableIds[slot] = id;
    },
  };
}
