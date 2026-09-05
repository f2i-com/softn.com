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
 * - The source is validated against a closed language before it reaches
 *   `new Function`: identifiers must be parameters, keywords, names the body
 *   declares with `let`, or labels; the only member access is `Math.imul`;
 *   there are no string, template or regular-expression literals, no `new`,
 *   `this`, `arguments`, `typeof`, `in` or `instanceof`, no `.` anywhere else.
 *   A function that passes can name nothing outside its parameters and
 *   locals, so it cannot reach the worker's globals.
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

const KEYWORDS = new Set([
  'let',
  'var',
  'const',
  'if',
  'else',
  'for',
  'while',
  'do',
  'break',
  'continue',
  'return',
  'function',
  'true',
  'false',
  'undefined',
  'null',
]);

/**
 * Words that may appear nowhere: neither as an identifier (the whitelist
 * already refuses them there) nor as a name a `let` or a parameter list
 * would otherwise admit.
 */
const RESERVED = new Set([
  'this',
  'new',
  'typeof',
  'instanceof',
  'in',
  'of',
  'delete',
  'void',
  'class',
  'extends',
  'super',
  'import',
  'export',
  'with',
  'yield',
  'await',
  'async',
  'try',
  'catch',
  'finally',
  'throw',
  'switch',
  'case',
  'default',
  'debugger',
  'enum',
  'arguments',
  'eval',
  'Math',
  'globalThis',
  'self',
  'window',
]);

/** The `Math` functions a body may call: pure, and numbers in and out. */
const MATH_PURE = new Set(['imul', 'floor', 'ceil', 'trunc', 'round', 'abs', 'min', 'max', 'clz32', 'sqrt', 'fround']);

/** The characters a token may be made of, beyond identifiers and numbers. */
const PUNCT = new Set('{}()[];,:?.+-*/%&|^~!<>='.split(''));

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

export class AccelValidationError extends Error {}

/**
 * Validate a function's parameter names and body against the closed language.
 * Throws {@link AccelValidationError} with the reason on the first violation.
 */
export function validateAccelSource(params: string[], body: string): void {
  const ident = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  const allowed = new Set<string>(KEYWORDS);
  for (const p of params) {
    if (!ident.test(p)) throw new AccelValidationError(`parameter ${JSON.stringify(p)} is not an identifier`);
    if (KEYWORDS.has(p) || RESERVED.has(p)) throw new AccelValidationError(`parameter ${p} shadows a keyword`);
    allowed.add(p);
  }
  if (body.length > 4 * 1024 * 1024) throw new AccelValidationError('body too long');
  // Only printable ASCII and ordinary whitespace: no quotes, backticks,
  // backslashes, comments or anything that could open another lexical world.
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    if (c === 34 || c === 39 || c === 96 || c === 92 || c === 35 || c === 64) {
      throw new AccelValidationError(`character ${JSON.stringify(body[i])} at ${i}`);
    }
    if (!(c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126))) {
      throw new AccelValidationError(`character code ${c} at ${i}`);
    }
  }
  // Tokenize.
  type Tok = { t: 'id' | 'num' | 'p'; v: string; i: number };
  const toks: Tok[] = [];
  let i = 0;
  const n = body.length;
  while (i < n) {
    const c = body.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      i++;
      continue;
    }
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36) {
      let j = i + 1;
      while (j < n) {
        const d = body.charCodeAt(j);
        if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 95 || d === 36) j++;
        else break;
      }
      toks.push({ t: 'id', v: body.slice(i, j), i });
      i = j;
      continue;
    }
    if (c >= 48 && c <= 57) {
      let j = i + 1;
      if (c === 48 && j < n && (body[j] === 'x' || body[j] === 'X')) {
        j++;
        while (j < n && /[0-9A-Fa-f]/.test(body[j])) j++;
      } else {
        while (j < n && /[0-9.]/.test(body[j])) j++;
        if (j < n && (body[j] === 'e' || body[j] === 'E')) {
          j++;
          if (j < n && (body[j] === '+' || body[j] === '-')) j++;
          while (j < n && /[0-9]/.test(body[j])) j++;
        }
      }
      if (j < n && /[A-Za-z_$]/.test(body[j])) throw new AccelValidationError(`bad number at ${i}`);
      toks.push({ t: 'num', v: body.slice(i, j), i });
      i = j;
      continue;
    }
    const ch = body[i];
    if (!PUNCT.has(ch)) throw new AccelValidationError(`character ${JSON.stringify(ch)} at ${i}`);
    toks.push({ t: 'p', v: ch, i });
    i++;
  }
  // Comments would have been rejected by `/` followed by `/` or `*` only as
  // division; make sure no `//` or `/*` sequence survives.
  for (let k = 0; k + 1 < toks.length; k++) {
    if (toks[k].v === '/' && (toks[k + 1].v === '/' || toks[k + 1].v === '*') && toks[k + 1].i === toks[k].i + 1) {
      throw new AccelValidationError(`comment at ${toks[k].i}`);
    }
  }
  // Declarations and labels extend the allowed set; every other identifier
  // must already be in it.
  const labels = new Set<string>();
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k];
    if (tok.t !== 'id') continue;
    const prev = k > 0 ? toks[k - 1] : null;
    const next = k + 1 < toks.length ? toks[k + 1] : null;
    if (tok.v === 'Math') {
      if (
        !(
          next &&
          next.v === '.' &&
          toks[k + 2] &&
          MATH_PURE.has(toks[k + 2].v) &&
          toks[k + 3] &&
          toks[k + 3].v === '('
        )
      ) {
        throw new AccelValidationError(`Math member other than a pure function call at ${tok.i}`);
      }
      k += 2; // skip `.name`
      continue;
    }
    if (prev && prev.v === '.') throw new AccelValidationError(`member access at ${tok.i}`);
    if (next && next.v === '.') throw new AccelValidationError(`member access at ${tok.i}`);
    if (tok.v === 'let' || tok.v === 'var' || tok.v === 'const') {
      // Declarator list: name [= initializer] {, name [= initializer]} ;
      let m = k + 1;
      for (;;) {
        const name = toks[m];
        if (!name || name.t !== 'id' || KEYWORDS.has(name.v) || RESERVED.has(name.v)) {
          throw new AccelValidationError(`bad declaration at ${tok.i}${name ? ` (${name.v})` : ''}`);
        }
        allowed.add(name.v);
        m++;
        if (toks[m] && toks[m].v === '=') {
          // Skip the initializer to the next top-level `,` or `;`.
          let depth = 0;
          m++;
          while (m < toks.length) {
            const v = toks[m].v;
            if (v === '(' || v === '[' || v === '{') depth++;
            else if (v === ')' || v === ']' || v === '}') depth--;
            else if (depth === 0 && (v === ',' || v === ';')) break;
            m++;
          }
        }
        if (toks[m] && toks[m].v === ',') {
          m++;
          continue;
        }
        break;
      }
      continue;
    }
    if (tok.v === 'function') {
      // Only an anonymous function expression: `function ( params ) {`.
      let m = k + 1;
      if (!toks[m] || toks[m].v !== '(') throw new AccelValidationError(`named function at ${tok.i}`);
      m++;
      while (toks[m] && toks[m].v !== ')') {
        if (toks[m].t === 'id' && !KEYWORDS.has(toks[m].v) && !RESERVED.has(toks[m].v)) allowed.add(toks[m].v);
        else if (toks[m].v !== ',') throw new AccelValidationError(`bad function parameter at ${toks[m].i}`);
        m++;
      }
      continue;
    }
    if (KEYWORDS.has(tok.v)) continue;
    // A label: `name :` at a statement start, or after break/continue.
    if (next && next.v === ':' && (!prev || prev.v === '{' || prev.v === ';' || prev.v === '}')) {
      labels.add(tok.v);
      continue;
    }
    if (prev && (prev.v === 'break' || prev.v === 'continue')) {
      if (!labels.has(tok.v)) throw new AccelValidationError(`unknown label ${tok.v} at ${tok.i}`);
      continue;
    }
    if (!allowed.has(tok.v)) throw new AccelValidationError(`identifier ${tok.v} at ${tok.i}`);
  }
}

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
      validateAccelSource(params as string[], body);
      // Strict mode: an assignment the validator somehow let through cannot
      // create a global, and `this` is undefined.
      const fn = new Function(...(params as string[]), '"use strict";' + body) as Compiled['fn'];
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
