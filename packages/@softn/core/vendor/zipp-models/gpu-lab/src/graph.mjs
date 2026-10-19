/** Strict, versioned data-only compute protocol. No shader source or eval. */
export class ComputeError extends Error {
  constructor(code, message) { super(message); this.name = 'ComputeError'; this.code = code; }
}
export function check(ok, code, message) { if (!ok) throw new ComputeError(code, message); }
export const DEFAULT_LIMITS = Object.freeze({
  maxNodes: 512, maxElements: 4194304, maxInputElements: 4194304,
  maxOutputElements: 4194304, maxLogicalBytes: 64 * 1024 * 1024,
  maxWork: 100000000, maxDimension: 65536, maxOutputs: 64,
  maxWebGLTextureBytes: 128 * 1024 * 1024,
  // Prepared sessions (`runtime.prepare`): how many one runtime keeps, and how
  // many training steps one `session.run` may submit as one command buffer.
  maxSessions: 16, maxStepsPerRun: 64,
});
/** Highest tensor rank. Kernels address every tensor as four padded dimensions. */
export const MAX_RANK = 4;
/** Block formats an input may hold without being expanded to float32.
 *
 * A quantized weight is the only thing in this protocol that is not float32,
 * and it exists for one reason: a checkpoint that is 500 MB of Q4_K is 3.2 GB
 * once expanded, which is the difference between a model a device can hold and
 * one it cannot. The blocks stay as bytes and a matmul decodes them as it
 * reads them.
 *
 * Q4_K and Q6_K, which between them are what a Q4_K_M checkpoint is made of --
 * a Qwen3-0.6B is 373 MB this way and 2,274 MB as float32, with nothing
 * decoded at all. Every further format is another decoder in every backend
 * held to bit-for-bit agreement, so they are added when a checkpoint needs
 * them rather than for completeness. Anything else -- Q5_K, Q8_0, the IQ
 * formats -- a loader expands to float32 on the way in, as it always has.
 */
export const QUANT = Object.freeze({
  q4_k: Object.freeze({block: 256, bytes: 144}),
  q6_k: Object.freeze({block: 256, bytes: 210}),
  // Not a checkpoint format: `i16` is this protocol's own, and it exists only
  // for `matmul_fixed`. A weight in it is already quantized the way that
  // operation quantizes, so the per-step decode-and-requantize is done once by
  // whoever built the graph -- with the row scales alongside it as a plain
  // float32 [N] input. It is 3.56 times larger than Q4_K on the device, which
  // is the trade and is the caller's to make: time for memory, in that
  // direction, which is the opposite of what every other entry here is for.
  //
  // One value to a block, two bytes, little-endian -- the byte order the half
  // scales in `quant.mjs` are already read with.
  i16: Object.freeze({block: 1, bytes: 2}),
});
export function sizeOf(shape) { return shape.reduce((a, b) => a * b, 1); }
// Operation families. Every name here is a fixed kernel; none becomes code.
export const BINARY_OPS = Object.freeze(['add', 'sub', 'mul', 'div', 'maximum', 'minimum', 'eq', 'ne', 'lt', 'le', 'gt', 'ge']);
/** Comparisons: float32 masks, 1 where the relation holds and 0 elsewhere (a NaN operand holds only `ne`). */
export const COMPARE_OPS = Object.freeze(['eq', 'ne', 'lt', 'le', 'gt', 'ge']);
/**
 * Operations version 3 added: `maximum`/`minimum`, the comparisons, `where`
 * and the counter-based `uniform`. Every version-1 and version-2 graph means
 * the same thing under version 3; a writer labels a graph 3 only once it uses
 * one of these, so an older host refuses what it cannot run instead of
 * misreading it.
 */
export const VERSION_THREE_OPS = Object.freeze([...COMPARE_OPS, 'maximum', 'minimum', 'where', 'uniform']);
/**
 * Operations version 4 added: element selection and its gradients. `slice`
 * reads a strided box, `slice_scatter` writes one into a copy of a base,
 * `index_select`/`gather` read along one axis by an integer index input, and
 * `index_add`/`scatter_add` accumulate along it. All of them move values
 * without arithmetic except the two accumulations, whose order is part of the
 * protocol: each output element is its base value plus the contributions in
 * ascending index position, one float32 addition at a time, left to right
 * (PyTorch's CPU order for index_add_ and scatter_add_). A writer labels a
 * graph 4 only once it uses one of these.
 */
export const VERSION_FOUR_OPS = Object.freeze(['slice', 'slice_scatter', 'index_select', 'index_add', 'gather', 'scatter_add']);
/**
 * The `uniform` bit generator: a keyed hash of (seed, step, element index),
 * integer arithmetic modulo 2^32 only, so every backend produces the same bits
 * and none depends on a transcendental function or a float rounding mode.
 * `mix` is Chris Wellons' lowbias32 finalizer. The value is the top 24 bits
 * times 2^-24: a float32 in [0, 1) that every backend forms exactly.
 */
export function uniformMix(x) {
  x = (x ^ (x >>> 16)) >>> 0; x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0; x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}
/** The two per-node keys: `k1` from the seed alone, `k2` from the step and `k1`. */
export function uniformKeys(seed, step) {
  const k1 = uniformMix((seed ^ 0x9e3779b9) >>> 0), k2 = uniformMix((step ^ k1) >>> 0);
  return [k1, k2];
}
/** Element `i`'s value: mix(mix(i ^ k2) + k1) >> 8, times 2^-24. */
export function uniformValue(k1, k2, i) {
  return (uniformMix((uniformMix((i ^ k2) >>> 0) + k1) >>> 0) >>> 8) * 5.9604644775390625e-8;
}
export const UNARY_OPS = Object.freeze(['relu', 'positive', 'neg', 'exp', 'log', 'sqrt', 'tanh', 'sigmoid', 'gelu', 'gelu_grad']);
export const REDUCE_OPS = Object.freeze(['sum', 'mean']);
function plain(obj) {
  return obj !== null && typeof obj === 'object' &&
    (Object.getPrototypeOf(obj) === Object.prototype || Object.getPrototypeOf(obj) === null);
}
function keys(obj, allowed, required = []) {
  check(plain(obj), 'PROTOCOL', 'Expected a plain data object');
  for (const k of Reflect.ownKeys(obj)) {
    check(typeof k === 'string' && allowed.includes(k), 'PROTOCOL', `Unknown field: ${String(k)}`);
    check('value' in Object.getOwnPropertyDescriptor(obj, k), 'PROTOCOL', 'Accessors are not data');
  }
  for (const k of required) check(Object.hasOwn(obj, k), 'PROTOCOL', `Missing field: ${k}`);
}
// Arrays are read by index, never with every/reduce, which skip holes.
function intArray(value, maxLength, what) {
  check(Array.isArray(value) && value.length <= maxLength, 'SHAPE', `${what} must be an array of at most ${maxLength} integers`);
  const out = [];
  for (let i = 0; i < value.length; i++) {
    check(Object.hasOwn(value, i) && Number.isSafeInteger(value[i]), 'SHAPE', `${what} must contain integers`);
    out.push(value[i]);
  }
  return out;
}
/**
 * `blocks` relaxes the element ceiling, and only that ceiling.
 *
 * `maxElements` exists because a float32 tensor of that many values must be
 * allocated as four bytes each. A quantized input is never allocated at that
 * size -- it is held as its blocks, and what it costs is charged against
 * `maxLogicalBytes` below. Applying the float32 ceiling to it would refuse a
 * 127 MB embedding table for being 155 million values, which is precisely the
 * arithmetic quantization exists to avoid. Every dimension is still bounded and
 * the product still stays a safe integer.
 */
function shapeOf(shape, limits, blocks = false) {
  const dims = intArray(shape, MAX_RANK, 'Shape');
  let size = 1;
  for (const d of dims) {
    check(d > 0 && d <= limits.maxDimension, 'SHAPE', 'Shape dimensions must be positive bounded integers');
    size *= d;
    check(Number.isSafeInteger(size), 'LIMIT', 'Tensor exceeds element limit');
    // Checked after every factor, so the product never leaves the safe-integer range.
    if (!blocks) check(size <= limits.maxElements, 'LIMIT', 'Tensor exceeds element limit');
  }
  return dims;
}
function finiteF32(v) {
  check(typeof v === 'number' && Number.isFinite(v) && Number.isFinite(Math.fround(v)),
    'NUMBER', 'Values must be finite float32 numbers');
  return Math.fround(v);
}
/** An owned float32 copy of a flat number array, holes and non-finite values rejected. */
export function float32Data(data) {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (typeof v !== 'number') finiteF32(v);
    out[i] = v;
    if (!Number.isFinite(out[i])) finiteF32(v); // NaN, infinity, or float32 overflow
  }
  return out;
}
/**
 * A Float32Array its caller hands over (a host's private copy of a request,
 * held by nothing else): checked like float32Data but not copied. Anything
 * else, or a non-finite value, goes through float32Data (its copy, its error).
 */
export function ownedFloat32(data) {
  if (!(data instanceof Float32Array)) return float32Data(data);
  for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i])) return float32Data(data);
  return data;
}
/** Readback's rule: every value of an output finite (a host may serve this natively). */
export function checkFiniteOutput(values) {
  for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i])) throw new ComputeError('NUMBER', 'Output contains non-finite values; graph readback requires finite float32');
}
/** Cross-entropy targets are indices: every value an integer in [0, classes). */
export function checkClassTargets(data, classes, op = 'cross_entropy') {
  // The message is built only for a failure: per element it was most of the check's cost.
  for (let i = 0; i < data.length; i++) {
    const t = data[i];
    if (!(Number.isInteger(t) && t >= 0 && t < classes)) check(false, 'NUMBER', `${op} targets must be an input of integer class indices in [0, C)`);
  }
}
/** An index input of the version-4 selections: every value an integer in [0, bound). */
export function checkIndices(data, bound) {
  for (let i = 0; i < data.length; i++) {
    const t = data[i];
    if (!(Number.isInteger(t) && t >= 0 && t < bound)) check(false, 'NUMBER', `Index values must be integers in [0, ${bound})`);
  }
}
function sameShape(a, b) { return a.length === b.length && a.every((v, i) => v === b[i]); }
/** Contiguous row-major strides, padded on the left to four dimensions. */
function strides4(shape) {
  const padded = pad4(shape), out = [0, 0, 0, 0];
  for (let d = 3, s = 1; d >= 0; d--) { out[d] = s; s *= padded[d]; }
  return out;
}
function pad4(shape) { return [...Array(MAX_RANK - shape.length).fill(1), ...shape]; }
/** NumPy broadcasting, right-aligned. Returns the output shape and per-operand strides (0 = broadcast). */
export function broadcast(aShape, bShape) {
  const rank = Math.max(aShape.length, bShape.length), shape = [];
  for (let i = 0; i < rank; i++) {
    const x = aShape[aShape.length - rank + i] ?? 1, y = bShape[bShape.length - rank + i] ?? 1;
    check(x === y || x === 1 || y === 1, 'SHAPE', `Shapes [${aShape}] and [${bShape}] cannot be broadcast`);
    shape.push(Math.max(x, y));
  }
  const dims = pad4(shape), expand = s => {
    const p = pad4(s), st = strides4(s);
    return st.map((v, d) => (p[d] === 1 && dims[d] !== 1) ? 0 : v);
  };
  return {shape, dims, aStrides: expand(aShape), bStrides: expand(bShape)};
}
/** A permutation as a strided gather: output dims (padded) and the source stride of each. */
function gather(n, inShape) {
  const r = inShape.length, inStrides = strides4(inShape);
  n.dims = pad4(n.shape);
  n.srcStrides = n.dims.map((_, d) => d < MAX_RANK - r ? 0 : inStrides[MAX_RANK - r + n.perm[d - (MAX_RANK - r)]]);
}
function axisOf(raw, rank) {
  check(Number.isSafeInteger(raw) && raw >= -Math.max(rank, 1) && raw < Math.max(rank, 1), 'SHAPE', 'Axis is out of range');
  // A scalar reduces as if it were [1], so -1 names that one axis too.
  return raw < 0 ? raw + Math.max(rank, 1) : raw;
}
/** Adam's bias-corrected scalars for `step`, from the program's own doubles. */
export function adamStep({lr, beta1, beta2}, step) {
  check(Number.isSafeInteger(step) && step >= 1 && step <= 2 ** 31, 'NUMBER', 'step must be a positive integer');
  const bc1 = 1 - Math.pow(beta1, step), bc2 = 1 - Math.pow(beta2, step);
  const stepSize = finiteF32(lr / bc1), bc2Sqrt = finiteF32(Math.sqrt(bc2));
  check(bc2Sqrt > 0, 'NUMBER', 'beta2 bias correction underflows float32');
  return {step, stepSize, bc2Sqrt};
}
const OPTIMIZER_FIELDS = {sgd_update: ['lr'], momentum_update: ['momentum', 'dampening'],
  adam_m: ['beta1'], adam_v: ['beta2'], adam_update: ['lr', 'beta1', 'beta2', 'eps', 'step']};
/**
 * `session` (a prepared plan): an `input` node may omit `data` (it is fed at
 * each `session.run`) and may name a program output as `carry`, whose value
 * becomes the input's for the next step. Plain `execute()` accepts neither.
 */
export function validateProgram(program, overrides = {}, {session = false} = {}) {
  keys(overrides, Object.keys(DEFAULT_LIMITS));
  for (const v of Object.values(overrides)) check(Number.isSafeInteger(v) && v > 0,
    'LIMIT', 'Limits must be positive safe integers');
  const limits = {...DEFAULT_LIMITS, ...overrides};
  keys(program, ['version', 'nodes', 'outputs'], ['version', 'nodes', 'outputs']);
  // Versions 1 to 4 share one validator: each names a larger operation set,
  // and every older graph means the same thing under the newer version.
  check(program.version === 1 || program.version === 2 || program.version === 3 || program.version === 4, 'PROTOCOL',
    'Only graph protocol versions 1, 2, 3 and 4 are supported');
  check(Array.isArray(program.nodes) && program.nodes.length > 0 && program.nodes.length <= limits.maxNodes,
    'LIMIT', 'Invalid graph node count');
  check(Array.isArray(program.outputs) && program.outputs.length > 0 && program.outputs.length <= limits.maxOutputs,
    'LIMIT', 'Invalid output count');
  const nodes = [], root = []; let logicalBytes = 0, work = 0, inputElements = 0;
  for (let id = 0; id < program.nodes.length; id++) {
    check(Object.hasOwn(program.nodes, id), 'PROTOCOL', 'Expected a plain data object');
    const raw = program.nodes[id];
    // Validate op before looking up a kernel; identifiers never become code.
    keys(raw, ['id', 'op', 'shape', 'data', 'value', 'a', 'b', 'c', 'axis', 'keepdim', 'dims',
      'lr', 'momentum', 'dampening', 'beta1', 'beta2', 'eps', 'step', 'carry',
      'dtype', 'transposed', 'seed', 'begin', 'stride'], ['id', 'op']);
    check(raw.id === id, 'PROTOCOL', 'Node IDs must be consecutive integers starting at zero');
    const n = {id, op: raw.op, refs: []};
    // `blocks` marks the one position that can read a quantized node: the
    // right-hand side of a transposed matmul, which decodes as it multiplies.
    // Everywhere else a quantized handle is a byte array standing where floats
    // are expected, so refusing it here is the difference between an error and
    // a tensor of plausible nonsense.
    const ref = (key, blocks = false) => {
      const r = raw[key];
      check(Number.isSafeInteger(r) && r >= 0 && r < id, 'REFERENCE', 'References must point to earlier nodes');
      const target = nodes[root[r]];
      check(blocks || !target?.quant, 'PROTOCOL',
        `Node ${r} is quantized; only the right-hand side of a matmul can read it`);
      n[key] = r; n.refs.push(r); return nodes[r];
    };
    let units = 0;
    // An index is data every kernel may address memory with, so it is an input
    // (static or fed, read through reshapes) whose values are checked here or
    // at each upload against the smallest extent any user indexes.
    const indexInput = (r, bound, what) => {
      const target = nodes[root[r]];
      check(target.op === 'input' && target.carry === undefined, 'NUMBER', `${what} takes its index from an input of integers`);
      if (target.data) checkIndices(target.data, bound);
      target.indexBound = Math.min(target.indexBound ?? bound, bound);
    };
    const op = typeof raw.op === 'string' ? raw.op : '';
    if (BINARY_OPS.includes(op)) {
      keys(raw, ['id', 'op', 'a', 'b'], ['a', 'b']);
      const a = ref('a'), b = ref('b'), bc = broadcast(a.shape, b.shape);
      n.shape = bc.shape; n.dims = bc.dims; n.aStrides = bc.aStrides; n.bStrides = bc.bStrides;
      // Fast paths every backend recognises; 'general' uses the padded strides.
      n.aScalar = a.size === 1 && n.shape.length > 0; n.bScalar = b.size === 1 && n.shape.length > 0;
      n.mode = sameShape(a.shape, b.shape) ? 'same' : a.size === 1 && sameShape(b.shape, n.shape) ? 'aScalar'
        : b.size === 1 && sameShape(a.shape, n.shape) ? 'bScalar' : 'general';
    } else if (UNARY_OPS.includes(op)) {
      keys(raw, ['id', 'op', 'a'], ['a']);
      const a = ref('a'); n.shape = [...a.shape];
      units = a.size * (['exp', 'log', 'tanh', 'sigmoid', 'gelu', 'gelu_grad'].includes(op) ? 4 : 1);
    } else if (REDUCE_OPS.includes(op)) {
      keys(raw, ['id', 'op', 'a', 'axis', 'keepdim'], ['a']);
      const a = ref('a');
      check(!Object.hasOwn(raw, 'keepdim') || typeof raw.keepdim === 'boolean', 'PROTOCOL', 'keepdim must be a boolean');
      n.keepdim = raw.keepdim === true; n.inputSize = a.size; n.inputShape = [...a.shape];
      if (Object.hasOwn(raw, 'axis')) {
        const axis = axisOf(raw.axis, a.shape.length); n.axis = axis;
        const dims = a.shape.length ? a.shape : [1];
        n.len = dims[axis]; n.outer = sizeOf(dims.slice(0, axis)); n.inner = sizeOf(dims.slice(axis + 1));
        n.shape = n.keepdim ? a.shape.map((d, i) => i === axis ? 1 : d) : a.shape.filter((_, i) => i !== axis);
      } else {
        n.whole = true; n.shape = n.keepdim ? a.shape.map(() => 1) : [];
      }
      units = a.size * 2;
    } else switch (op) {
      case 'input': {
        const fields = session ? ['id', 'op', 'shape', 'data', 'carry', 'dtype'] : ['id', 'op', 'shape', 'data', 'dtype'];
        keys(raw, fields, session ? ['shape'] : ['shape', 'data']);
        const quantized = Object.hasOwn(raw, 'dtype') && raw.dtype !== 'f32';
        n.shape = shapeOf(raw.shape, limits, quantized);
        if (quantized) {
          // A quantized input: its bytes are blocks, not values, and only a
          // matmul reading it as the right-hand side knows how to decode them.
          check(typeof raw.dtype === 'string' && Object.hasOwn(QUANT, raw.dtype), 'PROTOCOL',
            `Unsupported input dtype ${String(raw.dtype)}; this protocol holds f32 and ${Object.keys(QUANT).join(', ')}`);
          check(!session || !Object.hasOwn(raw, 'carry'), 'PROTOCOL', 'A quantized input is a constant, not a carried value');
          const {block, bytes} = QUANT[raw.dtype];
          const size = sizeOf(n.shape);
          check(size % block === 0, 'SHAPE',
            `A ${raw.dtype} tensor holds whole blocks of ${block}; ${size} is not a multiple of ${block}`);
          check(n.shape[n.shape.length - 1] % block === 0, 'SHAPE',
            `A ${raw.dtype} row must be whole blocks of ${block}; this one is ${n.shape[n.shape.length - 1]} wide`);
          check(Object.hasOwn(raw, 'data'), 'PROTOCOL', 'A quantized input carries its blocks');
          const blocks = size / block;
          check(raw.data instanceof Uint8Array && raw.data.length === blocks * bytes, 'SHAPE',
            `${raw.dtype} needs ${blocks * bytes} bytes for ${size} values; got ${raw.data?.length}`);
          // Charged as what crosses the boundary -- blocks -- in the float32
          // units this budget is expressed in, not as the values they stand for.
          inputElements += Math.ceil(blocks * bytes / 4);
          check(inputElements <= limits.maxInputElements, 'LIMIT', 'Total input exceeds limit');
          n.quant = {dtype: raw.dtype, block, bytes, blocks};
          // Owned, like every other input's data.
          n.data = raw.data.slice();
          n.size = size;
          root.push(id);
          // Charged as the bytes it is, not as the values it stands for: that
          // saving is the whole point of admitting it.
          logicalBytes += blocks * bytes; work += size;
          check(logicalBytes <= limits.maxLogicalBytes && work <= limits.maxWork,
            'LIMIT', 'Graph exceeds allocation or work budget');
          nodes.push(n);
          continue;
        }
        if (session && Object.hasOwn(raw, 'carry')) {
          check(typeof raw.carry === 'string', 'PROTOCOL', 'carry must name an output');
          n.carry = raw.carry; // checked against the outputs below
        }
        if (Object.hasOwn(raw, 'data')) {
          // A flat list of numbers, or a Float32Array (a ZIPP engine's binary
          // tensor transport): owned by the plan either way, and checked in
          // one pass for the typed form, whose elements are float32 already.
          check((raw.data instanceof Float32Array || Array.isArray(raw.data)) && raw.data.length === sizeOf(n.shape),
            'SHAPE', 'Flat input length does not match shape');
          inputElements += raw.data.length;
          check(inputElements <= limits.maxInputElements, 'LIMIT', 'Total input exceeds limit');
          n.data = float32Data(raw.data);
        } else n.fed = true; // no initial value: every session run supplies one
        break;
      }
      case 'full':
        keys(raw, ['id', 'op', 'shape', 'value'], ['shape', 'value']);
        n.shape = shapeOf(raw.shape, limits); n.value = finiteF32(raw.value); break;
      case 'uniform': {
        // Counter-based random numbers: element i of a (seed, step) draw is a
        // pure function of the three, so a draw is reproducible on every
        // backend and a prepared session gets a fresh one per step by
        // advancing `step` (as it advances adam_update's).
        keys(raw, ['id', 'op', 'shape', 'seed', 'step'], ['shape', 'seed']);
        n.shape = shapeOf(raw.shape, limits);
        check(Number.isSafeInteger(raw.seed) && raw.seed >= 0 && raw.seed <= 0xffffffff, 'NUMBER', 'seed must be an integer in [0, 2^32)');
        const step = Object.hasOwn(raw, 'step') ? raw.step : 1;
        check(Number.isSafeInteger(step) && step >= 1 && step <= 2 ** 31, 'NUMBER', 'step must be a positive integer');
        n.seed = raw.seed; n.step = step; units = sizeOf(n.shape) * 4; break;
      }
      case 'where': {
        // where(c, a, b): a where c is nonzero (a NaN counts as nonzero), b
        // where it is zero (either sign), all three broadcast together.
        keys(raw, ['id', 'op', 'c', 'a', 'b'], ['c', 'a', 'b']);
        const c = ref('c'), a = ref('a'), b = ref('b');
        const all = broadcast(broadcast(c.shape, a.shape).shape, b.shape);
        n.shape = all.shape; n.dims = all.dims;
        // Each operand's padded strides against the output (0 = broadcast).
        n.cStrides = broadcast(c.shape, n.shape).aStrides;
        n.aStrides = broadcast(a.shape, n.shape).aStrides; n.bStrides = broadcast(b.shape, n.shape).aStrides;
        n.mode = sameShape(c.shape, n.shape) && sameShape(a.shape, n.shape) && sameShape(b.shape, n.shape) ? 'same' : 'general';
        break;
      }
      case 'life': case 'transpose': {
        keys(raw, ['id', 'op', 'a'], ['a']); const a = ref('a');
        check(a.shape.length === 2, 'SHAPE', `${op} requires a matrix`);
        n.inputSize = a.size; n.inputShape = [...a.shape];
        if (op === 'life') { n.shape = [...a.shape]; units = a.size * 9; break; }
        n.shape = [a.shape[1], a.shape[0]]; n.perm = [1, 0]; gather(n, a.shape); break;
      }
      case 'permute': {
        keys(raw, ['id', 'op', 'a', 'dims'], ['a', 'dims']); const a = ref('a');
        const perm = intArray(raw.dims, MAX_RANK, 'Permutation');
        check(perm.length === a.shape.length && perm.every(d => d >= 0 && d < perm.length) && new Set(perm).size === perm.length,
          'SHAPE', 'dims must be a permutation of the input axes');
        n.perm = perm; n.shape = perm.map(d => a.shape[d]); n.inputShape = [...a.shape]; gather(n, a.shape); break;
      }
      case 'reshape': {
        keys(raw, ['id', 'op', 'a', 'shape'], ['a', 'shape']); const a = ref('a');
        n.shape = shapeOf(raw.shape, limits);
        check(sizeOf(n.shape) === a.size, 'SHAPE', 'reshape must keep the element count');
        // A reshape of a contiguous tensor is the same storage: no kernel runs.
        n.alias = true; units = 1; break;
      }
      case 'softmax': case 'log_softmax': {
        keys(raw, ['id', 'op', 'a', 'axis'], ['a']); const a = ref('a');
        check(a.shape.length >= 1, 'SHAPE', `${op} requires at least one dimension`);
        check(!Object.hasOwn(raw, 'axis') || axisOf(raw.axis, a.shape.length) === a.shape.length - 1,
          'SHAPE', `${op} supports the last axis only`);
        n.shape = [...a.shape]; n.cols = a.shape[a.shape.length - 1]; n.rows = a.size / n.cols;
        units = a.size * 4; break;
      }
      case 'matmul': {
        keys(raw, ['id', 'op', 'a', 'b', 'transposed'], ['a', 'b']);
        const a = ref('a'), b = ref('b', true);
        // `transposed`: b holds [N, K] rather than [K, N], which is how a
        // checkpoint stores a linear layer and the only way a quantized weight
        // can be read at all -- its blocks run along K, and blocks cannot be
        // transposed without decoding them.
        const transposed = Object.hasOwn(raw, 'transposed');
        if (transposed) check(raw.transposed === true, 'PROTOCOL', 'transposed is true when present');
        n.transposed = transposed;
        const ra = a.shape.length, rb = b.shape.length;
        const inner = transposed ? b.shape[rb - 1] : b.shape[rb - 2];
        check((ra === 2 || ra === 3) && (rb === 2 || rb === 3) && a.shape[ra - 1] === inner,
          'SHAPE', transposed ? 'transposed matmul requires [M,K] @ [N,K]' : 'matmul requires [M,K] @ [K,N] or batched [B,M,K] @ [B,K,N]');
        const quant = nodes[root[raw.b]]?.quant;
        // `i16` is not a checkpoint format a float32 matmul can decode -- it is
        // already quantized, and to a scale this node knows nothing about.
        // Refused here because every backend names its kernel after the dtype,
        // so the alternative is a lookup that finds nothing and an output left
        // at zero. Before the `transposed` check, so that the answer names the
        // real problem rather than one that would remain after fixing it.
        check(quant?.dtype !== 'i16', 'PROTOCOL',
          'An i16 weight carries no values a float32 matmul can read; it belongs to matmul_fixed, with its scales');
        check(!quant || transposed, 'PROTOCOL',
          'A quantized weight is stored [N, K]; its matmul must be transposed');
        const ba = ra === 3 ? a.shape[0] : 1, bb = rb === 3 ? b.shape[0] : 1;
        check(ba === bb || ba === 1 || bb === 1, 'SHAPE', 'matmul batch dimensions must match or be 1');
        n.batch = Math.max(ba, bb); n.m = a.shape[ra - 2]; n.k = a.shape[ra - 1];
        n.n = transposed ? b.shape[rb - 2] : b.shape[rb - 1];
        n.aBatchStride = ba === 1 ? 0 : n.m * n.k; n.bBatchStride = bb === 1 ? 0 : n.k * n.n;
        if (quant) n.bQuant = quant;
        n.shape = ra === 3 || rb === 3 ? [n.batch, n.m, n.n] : [n.m, n.n];
        shapeOf(n.shape, limits); units = 2 * n.batch * n.m * n.k * n.n; break;
      }
      case 'matmul_fixed': {
        // The same product as `matmul`, computed over integers.
        //
        // Both sides are quantized to int16 with a per-row scale derived from
        // the data, the k products are summed exactly, and the total is scaled
        // back once. Integer addition is associative, so every backend that
        // implements this reaches the *same* integer -- not one within a
        // tolerance of another. `matmul` is bit-for-bit by careful agreement
        // about float32 rounding order; this is bit-for-bit by construction,
        // which is what a proof system needs, since a prime field can express
        // an integer sum and cannot express IEEE-754 rounding.
        //
        // It is a separate operation and not a mode of `matmul` because it
        // makes a different promise. `matmul` answers "what does float32 say";
        // this answers "what do the integers say", and on a real projection the
        // two differ by about 2.3e-3 (worst absolute, cosine 1.000000). A graph
        // asks for one or the other; neither silently becomes the other.
        keys(raw, ['id', 'op', 'a', 'b', 'c', 'transposed'], ['a', 'b']);
        // A weight is stored [N, K] -- one contiguous row per output column --
        // and a per-row scale is only cheap in that layout. There is no second
        // layout to get wrong, so the flag is required rather than defaulted.
        // Checked here rather than listed as a required field, so that omitting
        // it and passing it as false give the one answer that says why.
        check(raw.transposed === true, 'PROTOCOL', 'matmul_fixed reads its weight as [N, K]: transposed is required and is true');
        const a = ref('a'), b = ref('b', true);
        n.transposed = true;
        const ra = a.shape.length, rb = b.shape.length;
        check((ra === 2 || ra === 3) && (rb === 2 || rb === 3) && a.shape[ra - 1] === b.shape[rb - 1],
          'SHAPE', 'matmul_fixed requires [M,K] @ [N,K] or batched [B,M,K] @ [B,N,K]');
        const ba = ra === 3 ? a.shape[0] : 1, bb = rb === 3 ? b.shape[0] : 1;
        check(ba === bb || ba === 1 || bb === 1, 'SHAPE', 'matmul_fixed batch dimensions must match or be 1');
        n.batch = Math.max(ba, bb); n.m = a.shape[ra - 2]; n.k = a.shape[ra - 1]; n.n = b.shape[rb - 2];
        // Exactness is the whole claim, so the accumulator's ceiling is checked
        // rather than assumed. Each product is under 2^30 and k of them are
        // summed; the JavaScript reference holds that in a double, which is
        // exact below 2^53, and the WASM kernel in an i64. The bound is reached
        // at k = 2^23, far above any real projection, but a graph is untrusted
        // input and this is the one place the guarantee could quietly lapse.
        check(n.k * 32767 * 32767 <= Number.MAX_SAFE_INTEGER, 'LIMIT',
          'matmul_fixed inner dimension is too large for an exact integer accumulator');
        n.aBatchStride = ba === 1 ? 0 : n.m * n.k; n.bBatchStride = bb === 1 ? 0 : n.n * n.k;
        const fixedQuant = nodes[root[raw.b]]?.quant;
        if (fixedQuant) n.bQuant = fixedQuant;
        // The bind-time form. An `i16` weight is already quantized, so it
        // arrives with the row scales it was quantized against -- a plain
        // float32 [N] input -- and this node does no decoding and no
        // requantising at all. It is the same answer as the run-time form,
        // moved in time: `quantizeWeight` in quant.mjs produces both, and the
        // tests hold the two to bit equality rather than to a tolerance.
        n.bFixed = fixedQuant?.dtype === 'i16';
        check(n.bFixed === Object.hasOwn(raw, 'c'), 'PROTOCOL', n.bFixed
          ? 'An i16 weight needs the row scales it was quantized against: pass them as c, a float32 [N] input'
          : 'c names row scales, which only an i16 weight has; a float32 or block weight is scaled from its own values');
        if (n.bFixed) {
          const scales = ref('c');
          check(scales.shape.length === 1 && scales.shape[0] === n.n, 'SHAPE',
            `matmul_fixed scales must be [N] for an [N, K] weight; got [${scales.shape}] against N = ${n.n}`);
          // One scale per output column, so a batch of weights would need a
          // batch of scale vectors. Refused rather than guessed at.
          check(bb === 1, 'SHAPE', 'A batched i16 weight is not supported; its scales would have to be batched too');
        }
        n.shape = ra === 3 || rb === 3 ? [n.batch, n.m, n.n] : [n.m, n.n];
        // Two quantisation passes on top of the product itself: one over the
        // activations, one over each decoded weight row.
        shapeOf(n.shape, limits);
        units = 2 * n.batch * n.m * n.k * n.n + 2 * n.batch * (n.m + n.n) * n.k; break;
      }
      case 'cross_entropy': case 'cross_entropy_grad': {
        keys(raw, ['id', 'op', 'a', 'b'], ['a', 'b']);
        const a = ref('a'), b = ref('b');
        check(a.shape.length === 2 && b.shape.length === 1 && b.shape[0] === a.shape[0],
          'SHAPE', `${op} requires logits [N,C] and class targets [N]`);
        // Targets are data, checked here: every kernel may then index with them.
        // A fed target input is checked at each upload instead (`classes`).
        check(b.op === 'input' && b.carry === undefined, 'NUMBER', `${op} targets must be an input of integer class indices in [0, C)`);
        // Static targets are checked here and also carry `classes`: a session
        // may feed any input per step, including one that began with data.
        if (b.data) checkClassTargets(b.data, a.shape[1], op);
        check(b.classes === undefined || b.classes === a.shape[1], 'SHAPE', `${op} targets are shared by logits of different widths`);
        b.classes = a.shape[1];
        n.rows = a.shape[0]; n.cols = a.shape[1];
        n.shape = op === 'cross_entropy' ? [] : [...a.shape]; units = a.size * 4; break;
      }
      case 'sgd_update': case 'momentum_update': case 'adam_m': case 'adam_v': case 'adam_update': {
        const fields = OPTIMIZER_FIELDS[op], refNames = op === 'adam_update' ? ['a', 'b', 'c'] : ['a', 'b'];
        keys(raw, ['id', 'op', ...refNames, ...fields], [...refNames, ...fields]);
        const inputs = refNames.map(ref);
        check(inputs.every(t => sameShape(t.shape, inputs[0].shape)), 'SHAPE', `${op} requires equal shapes`);
        for (const f of fields) if (f !== 'step') n[f] = finiteF32(raw[f]);
        for (const f of ['beta1', 'beta2']) if (f in n) check(raw[f] >= 0 && raw[f] < 1, 'NUMBER', `${f} must be in [0, 1)`);
        // Derived scalars come from the given doubles and round once, as PyTorch
        // rounds a Python-float expression when it scales a float32 tensor.
        if (op === 'momentum_update') n.w = finiteF32(1 - raw.dampening);
        if (op === 'adam_m') n.w = Math.fround(1 - raw.beta1);
        if (op === 'adam_v') n.w = Math.fround(1 - raw.beta2);
        if (op === 'adam_update') {
          check(Number.isSafeInteger(raw.step) && raw.step >= 1 && raw.step <= 2 ** 31, 'NUMBER', 'step must be a positive integer');
          check(raw.eps >= 0, 'NUMBER', 'eps must be non-negative');
          // Bias corrections are host constants, so no backend evaluates pow.
          // The program's own doubles stay on the node: a session advancing
          // the step recomputes them exactly as a fresh program would.
          n.raw = Object.freeze({lr: raw.lr, beta1: raw.beta1, beta2: raw.beta2});
          Object.assign(n, adamStep(n.raw, raw.step));
        }
        n.shape = [...inputs[0].shape]; units = inputs[0].size * 8; break;
      }
      case 'slice': case 'slice_scatter': {
        // slice: out[i] = a[begin + i * stride] per axis, a box of `shape`.
        // slice_scatter: a copy of `a` with that box (b's shape) replaced by b.
        // A stride is a nonzero integer; a negative one walks the axis backwards.
        const scatter = op === 'slice_scatter';
        keys(raw, scatter ? ['id', 'op', 'a', 'b', 'begin', 'stride'] : ['id', 'op', 'a', 'begin', 'stride', 'shape'],
          scatter ? ['a', 'b', 'begin', 'stride'] : ['a', 'begin', 'stride', 'shape']);
        const a = ref('a'), src = scatter ? ref('b') : null, rank = a.shape.length;
        check(rank >= 1, 'SHAPE', `${op} requires at least one dimension`);
        const box = scatter ? [...src.shape] : shapeOf(raw.shape, limits);
        const begin = intArray(raw.begin, MAX_RANK, 'begin'), stride = intArray(raw.stride, MAX_RANK, 'stride');
        check(box.length === rank && begin.length === rank && stride.length === rank, 'SHAPE',
          `${op} needs one begin, stride and extent per axis of the source`);
        for (let d = 0; d < rank; d++) {
          const last = begin[d] + (box[d] - 1) * stride[d];
          check(stride[d] !== 0 && Math.abs(stride[d]) <= limits.maxDimension, 'SHAPE', `${op} strides are nonzero integers`);
          check(begin[d] >= 0 && begin[d] < a.shape[d] && last >= 0 && last < a.shape[d], 'SHAPE',
            `${op} reads axis ${d} of [${a.shape}] outside its range`);
        }
        const aStrides = strides4(a.shape).slice(MAX_RANK - rank);
        // The box's walk through a's storage: an offset and a signed stride per padded axis.
        n.offset = begin.reduce((s, b, d) => s + b * aStrides[d], 0);
        n.boxDims = pad4(box);
        n.boxStrides = [...Array(MAX_RANK - rank).fill(0), ...aStrides.map((s, d) => s * stride[d])];
        n.begin4 = [...Array(MAX_RANK - rank).fill(0), ...begin];
        n.stride4 = [...Array(MAX_RANK - rank).fill(1), ...stride];
        n.shape = scatter ? [...a.shape] : box;
        n.dims = pad4(n.shape);
        units = scatter ? a.size + src.size : sizeOf(box);
        break;
      }
      case 'index_select': case 'gather': {
        // index_select: along `axis`, output position k reads a's position index[k]
        // (index is 1-D). gather: every output element reads a at its own
        // position, `axis` replaced by the index's value there (index has a's rank;
        // its other extents at most a's). Either index is an input of integers.
        keys(raw, ['id', 'op', 'a', 'b', 'axis'], ['a', 'b', 'axis']);
        const a = ref('a'), index = ref('b'), rank = a.shape.length;
        check(rank >= 1, 'SHAPE', `${op} requires at least one dimension`);
        const axis = axisOf(raw.axis, rank); n.axis = axis;
        if (op === 'index_select') {
          check(index.shape.length === 1, 'SHAPE', 'index_select takes a 1-D index');
          n.outer = sizeOf(a.shape.slice(0, axis)); n.len = a.shape[axis]; n.inner = sizeOf(a.shape.slice(axis + 1));
          n.count = index.shape[0];
          n.shape = a.shape.map((d, i) => i === axis ? n.count : d);
        } else {
          check(index.shape.length === rank && index.shape.every((d, i) => i === axis || d <= a.shape[i]), 'SHAPE',
            `gather needs an index of the source's rank, no larger than [${a.shape}] off axis ${axis}`);
          const st = strides4(a.shape);
          n.axisStride = st[MAX_RANK - rank + axis]; n.len = a.shape[axis];
          n.srcStrides = st.map((s, d) => d === MAX_RANK - rank + axis || d < MAX_RANK - rank ? 0 : s);
          n.shape = [...index.shape];
        }
        indexInput(raw.b, a.shape[axis], op);
        n.dims = pad4(n.shape);
        break;
      }
      case 'index_add': case 'scatter_add': {
        // A copy of base `a` plus source `b` accumulated at index `c` along
        // `axis`: each output element is its base value, then every
        // contribution that lands on it in ascending index position, one
        // float32 addition at a time. index_add: c is 1-D and b is a with that
        // axis c long. scatter_add: c has a's rank (no larger than a off the
        // axis) and b is c's shape.
        keys(raw, ['id', 'op', 'a', 'b', 'c', 'axis'], ['a', 'b', 'c', 'axis']);
        const a = ref('a'), src = ref('b'), index = ref('c'), rank = a.shape.length;
        check(rank >= 1, 'SHAPE', `${op} requires at least one dimension`);
        const axis = axisOf(raw.axis, rank); n.axis = axis;
        if (op === 'index_add') {
          check(index.shape.length === 1, 'SHAPE', 'index_add takes a 1-D index');
          n.outer = sizeOf(a.shape.slice(0, axis)); n.len = a.shape[axis]; n.inner = sizeOf(a.shape.slice(axis + 1));
          n.count = index.shape[0];
          check(sameShape(src.shape, a.shape.map((d, i) => i === axis ? n.count : d)), 'SHAPE',
            `index_add needs a source of shape [${a.shape.map((d, i) => i === axis ? n.count : d)}]`);
          units = a.size * n.count;
        } else {
          check(index.shape.length === rank && index.shape.every((d, i) => i === axis || d <= a.shape[i]), 'SHAPE',
            `scatter_add needs an index of the base's rank, no larger than [${a.shape}] off axis ${axis}`);
          check(sameShape(src.shape, index.shape), 'SHAPE', 'scatter_add needs a source of the index\'s shape');
          const st = strides4(a.shape);
          n.axisStride = st[MAX_RANK - rank + axis]; n.len = a.shape[axis];
          n.dstStrides = st.map((s, d) => d === MAX_RANK - rank + axis || d < MAX_RANK - rank ? 0 : s);
          n.indexDims = pad4(index.shape);
          n.axis4 = MAX_RANK - rank + axis;
          units = a.size * index.shape[axis];
        }
        indexInput(raw.c, a.shape[axis], op);
        n.shape = [...a.shape]; n.dims = pad4(n.shape);
        break;
      }
      default: throw new ComputeError('OP', `Unsupported operation: ${String(raw.op)}`);
    }
    n.size = sizeOf(n.shape);
    root.push(n.alias ? root[n.a] : id);
    logicalBytes += n.size * 4; work += units || n.size;
    check(logicalBytes <= limits.maxLogicalBytes && work <= limits.maxWork,
      'LIMIT', 'Graph exceeds allocation or work budget');
    nodes.push(n);
  }
  const names = new Set(); let outputElements = 0;
  const outputs = Array.from({length: program.outputs.length}, (_, i) => {
    check(Object.hasOwn(program.outputs, i), 'PROTOCOL', 'Expected a plain data object');
    const o = program.outputs[i];
    keys(o, ['name', 'id'], ['name', 'id']);
    check(typeof o.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(o.name) &&
      !['__proto__', 'prototype', 'constructor'].includes(o.name), 'PROTOCOL', 'Invalid output name');
    check(!names.has(o.name), 'PROTOCOL', 'Duplicate output name'); names.add(o.name);
    check(Number.isSafeInteger(o.id) && o.id >= 0 && o.id < nodes.length, 'REFERENCE', 'Invalid output reference');
    // Blocks are not a readable tensor: reading one back would hand out bytes
    // where the caller is promised float32.
    check(!nodes[root[o.id]]?.quant, 'PROTOCOL', `Output ${o.name} is a quantized tensor, which has no float32 readback`);
    outputElements += nodes[o.id].size;
    check(outputElements <= limits.maxOutputElements, 'LIMIT', 'Requested readback exceeds limit');
    return Object.freeze({...o});
  });
  // A carried input takes its next value from a program output of its shape.
  const byName = new Map(outputs.map(o => [o.name, o]));
  for (const n of nodes) if (n.carry !== undefined) {
    const o = byName.get(n.carry);
    check(o !== undefined, 'REFERENCE', `carry names no output: ${n.carry}`);
    check(sameShape(nodes[o.id].shape, n.shape), 'SHAPE', `carry ${n.carry} does not match the input shape`);
  }
  for (const n of nodes) Object.freeze(n);
  // Uses are counted per storage root: an alias (reshape) keeps its source alive
  // through its own consumers and outputs, and never frees anything itself.
  const uses = Array(nodes.length).fill(0);
  for (const n of nodes) if (!n.alias) for (const r of n.refs) uses[root[r]]++;
  for (const o of outputs) uses[root[o.id]]++;
  const adam = adamGroups(nodes, outputs, root), adamMembers = new Set([...adam.values()].flatMap(g => [g.m, g.v, g.u]));
  return {nodes, outputs, uses, root, limits, logicalBytes, work, inputElements, outputElements, session, adam, adamMembers};
}

/**
 * One parameter's Adam update as a group a backend may compute in one pass
 * (`impl.adam`): an adam_update whose moments are an adam_m and an adam_v of
 * the same gradient, every input of the three computed before the first of
 * them, so all three can run at the later of adam_m and adam_v (a loop holds
 * the earlier one, and what it releases, until then). Each element's
 * arithmetic is the three nodes' own. Keyed by that position: `{m, v, u, p, mIn, vIn,
 * inPlace}`, where `inPlace` says nothing after the group reads the old p, m
 * or v and no output is one of them (a session whose outputs are carried
 * straight back into those inputs may then update them where they are).
 */
function adamGroups(nodes, outputs, root) {
  const groups = new Map(), grouped = new Set();
  for (const u of nodes) {
    if (u.op !== 'adam_update') continue;
    const [p, mr, vr] = u.refs, M = nodes[mr], V = nodes[vr];
    if (M?.op !== 'adam_m' || V?.op !== 'adam_v' || root[M.refs[1]] !== root[V.refs[1]]) continue;
    if ([M.id, V.id, u.id].some(id => grouped.has(id))) continue;
    // The group runs where the later of adam_m and adam_v stands (every input
    // of both exists by then) if nothing before that reads the earlier one.
    const at = Math.max(M.id, V.id), early = Math.min(M.id, V.id), mIn = root[M.refs[0]], vIn = root[V.refs[0]], pIn = root[p];
    if (pIn >= at || nodes.some(n => !n.alias && n.id > early && n.id < at && n.refs.some(r => root[r] === early))) continue;
    const members = new Set([M.id, V.id, u.id]), olds = new Set([pIn, mIn, vIn]);
    let inPlace = olds.size === 3 && !outputs.some(o => olds.has(root[o.id]));
    for (const n of nodes) if (inPlace && !n.alias && n.id >= at && !members.has(n.id)) inPlace = !n.refs.some(r => olds.has(root[r]));
    groups.set(at, Object.freeze({m: M.id, v: V.id, u: u.id, p: pIn, mIn, vIn, inPlace}));
    for (const id of members) grouped.add(id);
  }
  return groups;
}
