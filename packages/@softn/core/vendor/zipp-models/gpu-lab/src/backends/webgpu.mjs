import {check, ComputeError, DEFAULT_LIMITS} from '../graph.mjs';
const UNSUPPORTED=new Set(['matmul_fixed']);

// Every kernel reads its shape and scalars from this uniform block, so one
// pipeline per kernel serves every shape. No graph value enters shader text.
const PRELUDE = `
struct Params { n: u32, mode: u32, op: u32, len: u32, d: vec4<u32>, sa: vec4<u32>, sb: vec4<u32>, g: vec4<u32>, f: vec4<f32> };
@group(0) @binding(0) var<uniform> P: Params;
fn flat(gid: vec3<u32>, nwg: vec3<u32>) -> u32 { return gid.x + gid.y * nwg.x * 256u; }
fn strided(i: u32, s: vec4<u32>) -> u32 {
  let x3 = i % P.d.w; let r3 = i / P.d.w; let x2 = r3 % P.d.z; let r2 = r3 / P.d.z;
  return (r2 / P.d.y) * s.x + (r2 % P.d.y) * s.y + x2 * s.z + x3 * s.w;
}
fn erf_series(z: f32) -> f32 {
  let t = z * z;
  return z * (1.1283791670955126 + t * (-0.37612638903183754 + t * (0.11283791670955126 + t * (-0.026866170645131252 +
    t * (0.005223977625442188 + t * (-0.0008548327023450852 + t * 0.00012055332981789664))))));
}
fn erfc_fit(a: f32) -> f32 {
  let t = 1.0 / (1.0 + 0.5 * a);
  return t * exp(-a * a - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
    t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
}
fn cdf(x: f32) -> f32 {
  let z = x * 0.7071067811865476;
  if (abs(z) < 0.5) { return 0.5 + 0.5 * erf_series(z); }
  if (z >= 10.0) { return 1.0; }
  if (z <= -10.0) { return 0.0; }
  let c = 0.5 * erfc_fit(abs(z));
  return select(c, 1.0 - c, z > 0.0);
}
// NaN by bits: WGSL lets a compiler assume no NaN reaches a comparison.
fn is_nan(x: f32) -> bool { return (bitcast<u32>(x) & 0x7fffffffu) > 0x7f800000u; }
// Binary operations by code: arithmetic, then maximum/minimum (NaN from either
// side, a tie to x) and 0/1 comparisons (NaN compares unequal).
fn binop(o: u32, x: f32, y: f32) -> f32 {
  switch o {
    case 0u: { return x + y; }
    case 1u: { return x - y; }
    case 2u: { return x * y; }
    case 3u: { return x / y; }
    default: {}
  }
  let unordered = is_nan(x) || is_nan(y);
  // A tie (-0 against +0 included) goes to x before any ordering is asked,
  // so no compiler rewrite into max()/min() can pick the zero's sign.
  if (o == 4u) { return select(select(select(x, y, x < y), x, x == y), x + y, unordered); }
  if (o == 5u) { return select(select(select(x, y, y < x), x, x == y), x + y, unordered); }
  if (o == 7u) { return select(0.0, 1.0, unordered || x != y); }
  if (unordered) { return 0.0; }
  switch o {
    case 6u: { return select(0.0, 1.0, x == y); }
    case 8u: { return select(0.0, 1.0, x < y); }
    case 9u: { return select(0.0, 1.0, x <= y); }
    case 10u: { return select(0.0, 1.0, x > y); }
    default: { return select(0.0, 1.0, x >= y); }
  }
}
// The uniform generator's hash: lowbias32 in u32 arithmetic, which wraps.
fn mix32(v: u32) -> u32 {
  var x = v;
  x = x ^ (x >> 16u); x = x * 0x7feb352du; x = x ^ (x >> 15u); x = x * 0x846ca68bu; return x ^ (x >> 16u);
}
fn tanh_s(x: f32) -> f32 {
  if (x != x) { return x; }
  let a = abs(x);
  if (a < 0.25) { let z = x * x; return x * (1.0 + z * (-0.3333333333333333 + z * (0.13333333333333333 + z * (-0.05396825396825397 + z * 0.021869488536155203)))); }
  let t = exp(-2.0 * min(a, 20.0));
  let r = (1.0 - t) / (1.0 + t);
  return select(r, -r, x < 0.0);
}`;
// A binds as array<f32>; B:u32 binds the same buffer as raw words, which is
// how a quantized weight arrives -- blocks, not values.
const io = (inputs, outputs = ['O'], vec4 = false) => inputs.map((name, i) => {
  const [id, type = vec4 ? 'vec4<f32>' : 'f32'] = name.split(':');
  return `@group(0) @binding(${i + 1}) var<storage, read> ${id}: array<${type}>;`;
}).join('\n') + outputs.map((name, i) => `\n@group(0) @binding(${inputs.length + 1 + i}) var<storage, read_write> ${name}: array<${vec4 ? 'vec4<f32>' : 'f32'}>;`).join('');
const each = body => `@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let i = flat(gid, nwg);
  if (i >= P.n) { return; }
  ${body}
}`;
/**
 * The vectorised form of an elementwise kernel: one invocation per four
 * consecutive elements, loaded and stored as vec4s through bindings sized to
 * whole vec4s. Each lane runs the scalar kernel's own arithmetic (the same
 * function on one f32), so every element's bits are the scalar kernel's; the
 * lanes past the tensor's end compute on the buffer's padding (every buffer
 * is a whole number of 256-byte blocks) and are never read.
 */
const each4 = body => `@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let i = flat(gid, nwg);
  if (i >= (P.n + 3u) / 4u) { return; }
  ${body}
}`;
const lanes = f => `vec4<f32>(${['x', 'y', 'z', 'w'].map(f).join(', ')})`;
// The scalar kernels' per-element code as functions of one lane.
const UNARY_LANE = `fn un(x: f32) -> f32 {
  var r: f32;
  switch P.op {
    case 0u: { r = select(0.0, x, x > 0.0 || x != x); }
    case 1u: { r = select(0.0, 1.0, x > 0.0); }
    case 2u: { r = -x; }
    case 3u: { r = exp(x); }
    case 4u: { r = log(x); }
    case 5u: { r = sqrt(x); }
    case 6u: { r = tanh_s(x); }
    case 7u: { let e = exp(-abs(x)); r = select(e / (1.0 + e), 1.0 / (1.0 + e), x >= 0.0); }
    case 8u: { r = x * cdf(x); }
    default: { r = cdf(x) + x * 0.3989422804014327 * exp(-0.5 * min(x * x, 200.0)); }
  }
  return r;
}`;
const OPTIM_LANE = `fn opt(a: f32, b: f32, c: f32) -> f32 {
  var r: f32;
  switch P.op {
    case 0u: { r = a - P.f.x * b; }
    case 1u: { r = P.f.x * a + P.f.y * b; }
    case 2u: { let w = P.f.x; if (w < 0.5) { r = a + w * (b - a); } else { r = b - (b - a) * (1.0 - w); } }
    case 3u: { r = a * P.f.x + P.f.y * b * b; }
    default: { r = a - P.f.x * (b / (sqrt(c) / P.f.y + P.f.z)); }
  }
  return r;
}`;
// Adam's group on one lane: new (m, v, p) from a (m), g, vv (v) and p.
const ADAM_LANE = `fn adam1(a: f32, g: f32, vv: f32, p: f32) -> vec3<f32> {
  let w = bitcast<f32>(P.sb.x);
  var m: f32;
  if (w < 0.5) { m = a + w * (g - a); } else { m = g - (g - a) * (1.0 - w); }
  let v = vv * bitcast<f32>(P.sb.y) + bitcast<f32>(P.sb.z) * g * g;
  return vec3<f32>(m, v, p - P.f.x * (m / (sqrt(v) / P.f.y + P.f.z)));
}`;
// ADAM_LANE for a second parameter in the same dispatch (`adam_pair_inplace4`):
// its scalars in d (w, beta2, w of adam_v) and sa (stepSize, bc2Sqrt, eps).
const ADAM_LANE_B = ADAM_LANE.replace('fn adam1(', 'fn adam1b(').replace('P.sb.x', 'P.d.x').replace('P.sb.y', 'P.d.y')
  .replace('P.sb.z', 'P.d.z').replace('P.f.x', 'bitcast<f32>(P.sa.x)').replace('P.f.y', 'bitcast<f32>(P.sa.y)')
  .replace('P.f.z', 'bitcast<f32>(P.sa.z)');
/**
 * One kernel for a chain of elementwise nodes (`fusion`'s chain groups):
 * each member's value computed as its own kernel computes it -- the unary
 * switch's case, `binop`, or a K=1 matmul's `0.0 + a * b` -- from earlier
 * members' values and the inputs, in the chain's order. Every member value
 * passes through `opaque` (its bits XOR a uniform word that is zero) before
 * anything reads it, so the compiler can neither see nor fuse across it: a
 * product feeding a sum stays two roundings, as when it went through memory.
 * The K=1 matmul's zero is that uniform word too: a literal `0.0 + x` may be
 * folded to `x`, which keeps a -0 the matmul kernel's sum makes +0.
 * `members`: [{kind, op, args: [{member: j} | {input: k, scalar}], out: k|-1}],
 * inputs E0.., outputs O0...
 */
function chainKernel(members, inputs, outputs) {
  const operand = a => a.member !== undefined ? `w${a.member}` : a.scalar ? `E${a.input}[0]` : `E${a.input}[i]`;
  return [inputs.map((_, k) => `E${k}`), `${CHAIN_FNS}
${each(chainLines(members, operand, 'P.g.x').join('\n  '))}`, outputs.map((_, k) => `O${k}`)];
}
/**
 * A chain's statements at element `i` (`cols`: a K=1 member's row length;
 * `zero`: a uniform word that is zero, as `chainFns` was given).
 */
function chainLines(members, operand, cols, zero = 'P.len') {
  return members.map((m, j) => {
    const [x, y] = m.args.map(operand);
    const value = m.kind === 'unary' ? `un(${m.op}u, ${x})`
      : m.kind === 'binary' ? `binop(${m.op}u, ${x}, ${y})`
      : `bitcast<f32>(${zero}) + E${m.args[0].input}[i / ${cols}] * E${m.args[1].input}[i % ${cols}]`;
    return `let v${j} = ${value}; let w${j} = opaque(v${j});${m.out >= 0 ? ` O${m.out}[i] = v${j};` : ''}`;
  });
}
/**
 * A chain whose input `mm.input` is a 2-D matmul's result, computed where the
 * matmul's 16x16 deep-slice kernel (`deepMatmul`) has each output: the
 * product as that kernel sums it, passed through `opaque` as the chain reads
 * it from memory, then the chain at that element. Inputs A, B (the
 * product's), then the chain's others (E<k>).
 */
function matmulChainKernel(members, inputs, outputs, mm) {
  const operand = a => a.member !== undefined ? `w${a.member}` : a.input === mm.input ? 'mmv' : a.scalar ? `E${a.input}[0]` : `E${a.input}[i]`;
  const [ins, source] = deepMatmul(mm.transB, false, mm.transA, false, DEEP_K,
    chainLines(members, operand, 'N'));
  return [[...ins, ...inputs.map((_, k) => k).filter(k => k !== mm.input).map(k => `E${k}`)], source, outputs.map((_, k) => `O${k}`)];
}
/**
 * A split matmul's chain (see `matmulChainKernel`): `reduce`'s sum of the
 * slices at each output, passed through `opaque`, then the chain there.
 * Inputs A (the slices), then the chain's others; P.op is the zero word and
 * g.y the product's row length.
 */
function reduceChainKernel(members, inputs, outputs, mmInput) {
  const operand = a => a.member !== undefined ? `w${a.member}` : a.input === mmInput ? 'mmv' : a.scalar ? `E${a.input}[0]` : `E${a.input}[i]`;
  const store = '  O[i] = select(s, s / f32(P.len), P.mode == 1u);\n}';
  const source = KERNELS.reduce[1];
  if (!source.endsWith(store)) throw new Error('reduce kernel changed');
  return [['A', ...inputs.map((_, k) => k).filter(k => k !== mmInput).map(k => `E${k}`)],
    `${chainFns('P.op')}\n${source.slice(0, -store.length)}  let mmv = opaque(s);
  ${chainLines(members, operand, 'P.g.y', 'P.op').join('\n  ')}
}`, outputs.map((_, k) => `O${k}`), {threads: 64}];
}
const chainFns = zero => CHAIN_FNS.replace('^ P.len)', `^ ${zero})`);
const CHAIN_FNS = `fn opaque(x: f32) -> f32 { return bitcast<f32>(bitcast<u32>(x) ^ P.len); }
fn un(op: u32, x: f32) -> f32 {
  var r: f32;
  switch op {
    case 0u: { r = select(0.0, x, x > 0.0 || x != x); }
    case 1u: { r = select(0.0, 1.0, x > 0.0); }
    case 2u: { r = -x; }
    case 3u: { r = exp(x); }
    case 4u: { r = log(x); }
    case 5u: { r = sqrt(x); }
    case 6u: { r = tanh_s(x); }
    case 7u: { let e = exp(-abs(x)); r = select(e / (1.0 + e), 1.0 / (1.0 + e), x >= 0.0); }
    case 8u: { r = x * cdf(x); }
    default: { r = cdf(x) + x * 0.3989422804014327 * exp(-0.5 * min(x * x, 200.0)); }
  }
  return r;
}`;
const ROW_STATS = `let base = i * P.len;
  var m = A[base];
  for (var j = 1u; j < P.len; j = j + 1u) { let v = A[base + j]; m = select(m, v, v > m || v != v); }
  var s = 0.0;
  for (var j = 0u; j < P.len; j = j + 1u) { s = s + exp(A[base + j] - m); }`;
function ceBoth(scaled) {
  const grad = scaled ? 'select(binop(2u, opaque(g), S[0]), binop(2u, S[0], opaque(g)), P.mode == 1u)' : 'g';
  return `var<workgroup> T: array<f32, 2048>;
fn opaque(x: f32) -> f32 { return bitcast<f32>(bitcast<u32>(x) ^ P.op); }
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) li: u32) {
  let rows = P.n;
  for (var i = li; i < rows; i = i + 256u) {
    ${ROW_STATS}
    let t = min(u32(max(Tg[i], 0.0)), P.len - 1u);
    T[i] = log(s) - (A[base + t] - m);
    for (var j = 0u; j < P.len; j = j + 1u) {
      let g = (exp(A[base + j] - m) / s - select(0.0, 1.0, j == t)) / f32(P.n);
      O2[base + j] = ${grad};
    }
  }
  workgroupBarrier();
  var total = 0.0;
  if (rows == 1u) { total = T[0] / 1.0; }
  var len = rows; var src = 0u;
  loop {
    if (len <= 1u) { break; }
    let next = (len + 1u) / 2u; let dst = 1024u - src;
    for (var j = li; j < next; j = j + 256u) { let jj = j * 2u; var other = 0.0; if (jj + 1u < len) { other = T[src + jj + 1u]; } T[dst + j] = T[src + jj] + other; }
    workgroupBarrier();
    src = dst; len = next;
  }
  if (li == 0u) {
    if (rows != 1u) { total = T[src]; }
    O[0] = total / P.f.x;
  }
}`;
}
const KERNELS = {
  fill: [[], each('O[i] = P.f.x;')],
  unary: [['A'], each(`let x = A[i];
  var r: f32;
  switch P.op {
    case 0u: { r = select(0.0, x, x > 0.0 || x != x); }
    case 1u: { r = select(0.0, 1.0, x > 0.0); }
    case 2u: { r = -x; }
    case 3u: { r = exp(x); }
    case 4u: { r = log(x); }
    case 5u: { r = sqrt(x); }
    case 6u: { r = tanh_s(x); }
    case 7u: { let e = exp(-abs(x)); r = select(e / (1.0 + e), 1.0 / (1.0 + e), x >= 0.0); }
    case 8u: { r = x * cdf(x); }
    default: { r = cdf(x) + x * 0.3989422804014327 * exp(-0.5 * min(x * x, 200.0)); }
  }
  O[i] = r;`)],
  binary: [['A', 'B'], each(`var ia = i; var ib = i;
  if (P.mode == 1u) { ia = 0u; } else if (P.mode == 2u) { ib = 0u; } else if (P.mode == 3u) { ia = strided(i, P.sa); ib = strided(i, P.sb); }
  O[i] = binop(P.op, A[ia], B[ib]);`)],
  // where(c, a, b) (C = condition): nonzero bits (NaN included) pick A. g holds b's strides.
  where: [['C', 'A', 'B'], each(`var ic = i; var ia = i; var ib = i;
  if (P.mode == 3u) { ic = strided(i, P.sa); ia = strided(i, P.sb); ib = strided(i, P.g); }
  O[i] = select(B[ib], A[ia], (bitcast<u32>(C[ic]) & 0x7fffffffu) != 0u);`)],
  // Counter-based uniform numbers: g.x the seed, g.y the step.
  uniform: [[], each(`let k1 = mix32(P.g.x ^ 0x9e3779b9u); let k2 = mix32(P.g.y ^ k1);
  O[i] = f32(mix32(mix32(i ^ k2) + k1) >> 8u) * 5.9604644775390625e-8;`)],
  gather: [['A'], each('O[i] = A[strided(i, P.sa)];')],
  // Version 4. slice: the strided gather from the box's first element (g.x);
  // negative strides arrive as two's-complement words and u32 arithmetic wraps
  // modulo 2^32, so the sum is the signed one.
  slice: [['A'], each('O[i] = A[P.g.x + strided(i, P.sa)];')],
  // slice_scatter over the base's padded dims (d): inside the box (begin sa,
  // signed stride sb, extent g) the source's value, elsewhere the base's.
  slice_scatter: [['A', 'B'], each(`let x3 = i % P.d.w; let r3 = i / P.d.w; let x2 = r3 % P.d.z; let r2 = r3 / P.d.z;
  let x = vec4<i32>(i32(r2 / P.d.y), i32(r2 % P.d.y), i32(x2), i32(x3));
  let begin = bitcast<vec4<i32>>(P.sa); let stride = bitcast<vec4<i32>>(P.sb); let ext = vec4<i32>(P.g);
  var q = vec4<i32>(0); var inside = true;
  for (var k = 0; k < 4; k = k + 1) {
    let s = abs(stride[k]); let t = select(begin[k] - x[k], x[k] - begin[k], stride[k] > 0);
    if (t < 0 || t % s != 0 || t / s >= ext[k]) { inside = false; break; }
    q[k] = t / s;
  }
  if (inside) { O[i] = B[u32(((q.x * ext.y + q.y) * ext.z + q.z) * ext.w + q.w)]; } else { O[i] = A[i]; }`)],
  // index_select over [outer, N = g.x, inner = g.y]; len is the index's (B) length.
  index_select: [['A', 'B'], each(`let inner = P.g.y; let r = i % inner; let k = (i / inner) % P.len; let o = i / (inner * P.len);
  let p = u32(clamp(i32(B[k]), 0, i32(P.g.x) - 1));
  O[i] = A[(o * P.g.x + p) * inner + r];`)],
  // index_add: the base (A) plus every source row (B, [outer, len, inner]) whose
  // index (C) names this position, in ascending k.
  // One 64-wide workgroup per output row (o, p): the row starts as the base,
  // then the workgroup walks the index 64 entries at a time, and every entry
  // naming p adds its source row, in ascending k -- each element's additions
  // are the per-element loop's, one float32 addition at a time, while the
  // index is read once per row instead of once per element.
  index_add: [['A', 'B', 'C'], `var<workgroup> hitAt: array<u32, 64>;
var<workgroup> hits: atomic<u32>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let inner = P.g.y; let row = wg.x + wg.y * nwg.x;
  if (row >= P.n / inner) { return; }
  let p = row % P.g.x; let o = row / P.g.x; let base = row * inner;
  for (var r = lid; r < inner; r = r + 64u) { O[base + r] = A[base + r]; }
  for (var k0 = 0u; k0 < P.len; k0 = k0 + 64u) {
    let before = atomicLoad(&hits);
    workgroupBarrier();
    let k = k0 + lid;
    var hit = 0u;
    if (k < P.len) { if (i32(C[k]) == i32(p)) { hit = 1u; atomicAdd(&hits, 1u); } }
    hitAt[lid] = hit;
    workgroupBarrier();
    if (atomicLoad(&hits) != before) {
      let span = min(64u, P.len - k0);
      for (var j = 0u; j < span; j = j + 1u) {
        if (hitAt[j] != 0u) {
          let src = (o * P.len + k0 + j) * inner;
          for (var r = lid; r < inner; r = r + 64u) { O[base + r] = O[base + r] + B[src + r]; }
        }
      }
    }
  }
}`],
  // gather over the index's padded dims (d): a's strides with the axis zeroed
  // (sa), plus the index value (B, clamped below g.y) times the axis stride g.x.
  gather_axis: [['A', 'B'], each('O[i] = A[strided(i, P.sa) + u32(clamp(i32(B[i]), 0, i32(P.g.y) - 1)) * P.g.x];')],
  // scatter_add over the base's padded dims (d): the index's padded dims (sa)
  // and the padded axis (g.x); every index element along the axis at this
  // position off the axis that names it adds its source, in ascending order.
  // The index element at k along the axis is j0 + k * its axis stride (no
  // vector written through a runtime index: Direct3D's FXC refuses that).
  scatter_add: [['A', 'B', 'C'], each(`let x3 = i % P.d.w; let r3 = i / P.d.w; let x2 = r3 % P.d.z; let r2 = r3 / P.d.z;
  let x = vec4<u32>(r2 / P.d.y, r2 % P.d.y, x2, x3);
  let axis = P.g.x;
  let onAxis = vec4<bool>(axis == 0u, axis == 1u, axis == 2u, axis == 3u);
  var v = A[i];
  if (!any(select(x >= P.sa, vec4<bool>(false), onAxis))) {
    let q = select(x, vec4<u32>(0u), onAxis);
    let j0 = ((q.x * P.sa.y + q.y) * P.sa.z + q.z) * P.sa.w + q.w;
    let strides = vec4<u32>(P.sa.y * P.sa.z * P.sa.w, P.sa.z * P.sa.w, P.sa.w, 1u);
    let skip = strides[axis]; let count = P.sa[axis]; let want = i32(x[axis]);
    for (var k = 0u; k < count; k = k + 1u) {
      let j = j0 + k * skip;
      if (i32(C[j]) == want) { v = v + B[j]; }
    }
  }
  O[i] = v;`)],
  // A whole sum of up to 2048 values in one workgroup: the same pairwise
  // tree as `pair` (level by level, out[j] = in[2j] + in[2j+1] or + 0.0 for
  // an odd one out), through workgroup memory, then `scale`'s division
  // (by f.x) when P.mode is 1. A lone value is divided by 1.0 first, as the
  // pairwise sum of one value does.
  sum_small: [['A'], `var<workgroup> T: array<f32, 2048>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) li: u32) {
  let n = P.n;
  var len = (n + 1u) / 2u;
  for (var j = li; j < len; j = j + 256u) { let jj = j * 2u; var other = 0.0; if (jj + 1u < n) { other = A[jj + 1u]; } T[j] = A[jj] + other; }
  workgroupBarrier();
  var src = 0u;
  loop {
    if (len <= 1u) { break; }
    let next = (len + 1u) / 2u; let dst = 1024u - src;
    for (var j = li; j < next; j = j + 256u) { let jj = j * 2u; var other = 0.0; if (jj + 1u < len) { other = T[src + jj + 1u]; } T[dst + j] = T[src + jj] + other; }
    workgroupBarrier();
    src = dst; len = next;
  }
  if (li == 0u) {
    var total = T[src];
    if (n == 1u) { total = A[0] / 1.0; }
    O[0] = select(total, total / P.f.x, P.mode == 1u);
  }
}`],
  // cross_entropy in one workgroup for up to 1024 rows: each row's loss as
  // `ce_rows` computes it, the rows' pairwise sum as `sum_small`, then the
  // mean as `scale` (divided by f.x = rows).
  ce_small: [['A', 'Tg'], `var<workgroup> T: array<f32, 2048>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) li: u32) {
  let rows = P.n;
  for (var i = li; i < rows; i = i + 256u) {
    ${ROW_STATS}
    let t = min(u32(max(Tg[i], 0.0)), P.len - 1u);
    T[i] = log(s) - (A[base + t] - m);
  }
  workgroupBarrier();
  var total = 0.0;
  if (rows == 1u) { total = T[0] / 1.0; }
  var len = rows; var src = 0u;
  loop {
    if (len <= 1u) { break; }
    let next = (len + 1u) / 2u; let dst = 1024u - src;
    for (var j = li; j < next; j = j + 256u) { let jj = j * 2u; var other = 0.0; if (jj + 1u < len) { other = T[src + jj + 1u]; } T[dst + j] = T[src + jj] + other; }
    workgroupBarrier();
    src = dst; len = next;
  }
  if (li == 0u) {
    if (rows != 1u) { total = T[src]; }
    O[0] = total / P.f.x;
  }
}`],
  // cross_entropy and its gradient over the same logits and targets in one
  // workgroup, for up to 256 rows (fusion's `ce` groups): each row's
  // statistics as both kernels compute them, its loss as `ce_small` and its
  // gradient as `ce_grad` (O2), then the loss's pairwise sum and mean.
  ce_both: [['A', 'Tg'], ceBoth(false), ['O', 'O2']],
  // The same, the gradient then multiplied by a scalar (S[0]) as `binary`
  // multiplies it: P.mode 1, S is the product's first operand, else its
  // second. The gradient passes through `opaque` (P.op is zero) first.
  ce_both_s: [['A', 'Tg', 'S'], ceBoth(true), ['O', 'O2']],
  pair: [['A'], each('let j = i * 2u; var other = 0.0; if (j + 1u < P.len) { other = A[j + 1u]; } O[i] = A[j] + other;')],
  scale: [['A'], each('O[i] = A[i] / P.f.x;')],
  // Eight loads issued before their eight additions, which stay one at a
  // time in ascending j: the same sum, without a memory round trip per term.
  // 64 invocations a workgroup: a sum over few outputs still spreads over
  // many of the GPU's cores (each output's additions stay in one invocation).
  reduce: [['A'], `@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let i = gid.x + gid.y * nwg.x * 64u;
  if (i >= P.n) { return; }
  let inner = P.g.x; let base = (i / inner) * P.len * inner + i % inner;
  var s = 0.0;
  var j = 0u;
  for (; j + 16u <= P.len; j = j + 16u) {
    let at = base + j * inner;
    let v0 = A[at]; let v1 = A[at + inner]; let v2 = A[at + 2u * inner]; let v3 = A[at + 3u * inner];
    let v4 = A[at + 4u * inner]; let v5 = A[at + 5u * inner]; let v6 = A[at + 6u * inner]; let v7 = A[at + 7u * inner];
    let v8 = A[at + 8u * inner]; let v9 = A[at + 9u * inner]; let v10 = A[at + 10u * inner]; let v11 = A[at + 11u * inner];
    let v12 = A[at + 12u * inner]; let v13 = A[at + 13u * inner]; let v14 = A[at + 14u * inner]; let v15 = A[at + 15u * inner];
    s = s + v0; s = s + v1; s = s + v2; s = s + v3; s = s + v4; s = s + v5; s = s + v6; s = s + v7;
    s = s + v8; s = s + v9; s = s + v10; s = s + v11; s = s + v12; s = s + v13; s = s + v14; s = s + v15;
  }
  for (; j < P.len; j = j + 1u) { s = s + A[base + j * inner]; }
  O[i] = select(s, s / f32(P.len), P.mode == 1u);
}`, ['O'], {threads: 64}],
  softmax: [['A'], each(`${ROW_STATS}
  if (P.mode == 1u) { let ls = log(s); for (var j = 0u; j < P.len; j = j + 1u) { O[base + j] = (A[base + j] - m) - ls; } }
  else { for (var j = 0u; j < P.len; j = j + 1u) { O[base + j] = exp(A[base + j] - m) / s; } }`)],
  ce_rows: [['A', 'T'], each(`${ROW_STATS}
  let t = min(u32(max(T[i], 0.0)), P.len - 1u);
  O[i] = log(s) - (A[base + t] - m);`)],
  ce_grad: [['A', 'T'], each(`${ROW_STATS}
  let t = min(u32(max(T[i], 0.0)), P.len - 1u);
  for (var j = 0u; j < P.len; j = j + 1u) { O[base + j] = (exp(A[base + j] - m) / s - select(0.0, 1.0, j == t)) / f32(P.n); }`)],
  // Adam's adam_m, adam_v and adam_update of one parameter in one pass
  // (graph.mjs adamGroups): each the same expression as `optim`'s case, in
  // the same order, with m and v passed on in registers rather than through
  // memory. sb holds adam_m's w and adam_v's beta2 and w as float bits; f the
  // update's stepSize, bc2Sqrt and eps, where `optim` has them.
  adam: [['W', 'Mi', 'Vi', 'G'], each(`let g = G[i]; let a = Mi[i]; let w = bitcast<f32>(P.sb.x);
  var m: f32;
  if (w < 0.5) { m = a + w * (g - a); } else { m = g - (g - a) * (1.0 - w); }
  let v = Vi[i] * bitcast<f32>(P.sb.y) + bitcast<f32>(P.sb.z) * g * g;
  O[i] = m; O2[i] = v;
  O3[i] = W[i] - P.f.x * (m / (sqrt(v) / P.f.y + P.f.z));`), ['O', 'O2', 'O3']],
  // The same, updating a session's held m, v and p where they are: each
  // element is read before it is written, by the one invocation that owns it.
  adam_inplace: [['G'], each(`let g = G[i]; let a = O[i]; let w = bitcast<f32>(P.sb.x);
  var m: f32;
  if (w < 0.5) { m = a + w * (g - a); } else { m = g - (g - a) * (1.0 - w); }
  let v = O2[i] * bitcast<f32>(P.sb.y) + bitcast<f32>(P.sb.z) * g * g;
  let p = O3[i];
  O[i] = m; O2[i] = v;
  O3[i] = p - P.f.x * (m / (sqrt(v) / P.f.y + P.f.z));`), ['O', 'O2', 'O3']],
  optim: [['A', 'B', 'C'], each(`let a = A[i]; let b = B[i];
  var r: f32;
  switch P.op {
    case 0u: { r = a - P.f.x * b; }
    case 1u: { r = P.f.x * a + P.f.y * b; }
    case 2u: { let w = P.f.x; if (w < 0.5) { r = a + w * (b - a); } else { r = b - (b - a) * (1.0 - w); } }
    case 3u: { r = a * P.f.x + P.f.y * b * b; }
    default: { r = a - P.f.x * (b / (sqrt(C[i]) / P.f.y + P.f.z)); }
  }
  O[i] = r;`)],
  life: [['A'], each(`let h = i32(P.g.x); let w = i32(P.g.y);
  let x = i32(i % P.g.y); let y = i32(i / P.g.y);
  var count = 0u;
  for (var dy = -1; dy <= 1; dy = dy + 1) {
    for (var dx = -1; dx <= 1; dx = dx + 1) {
      if (dx != 0 || dy != 0) { count = count + select(0u, 1u, A[u32(((y + dy + h) % h) * w + (x + dx + w) % w)] > 0.5); }
    }
  }
  O[i] = select(0.0, 1.0, count == 3u || (A[i] > 0.5 && count == 2u));`)],
  // 16x16 output tiles staged through workgroup memory. Each output still
  // accumulates its k products in order; bounds are handled by zero padding
  // so every invocation reaches both barriers.
  matmul: [['A', 'B'], `var<workgroup> As: array<array<f32, 16>, 16>;
var<workgroup> Bs: array<array<f32, 16>, 16>;
@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let M = P.g.x; let K = P.g.y; let N = P.g.z;
  let row = wg.y * 16u + lid.y; let col = wg.x * 16u + lid.x;
  let aBase = wg.z * P.sa.x; let bBase = wg.z * P.sa.y;
  var acc = 0.0;
  for (var t = 0u; t < K; t = t + 16u) {
    let ka = t + lid.x; let kb = t + lid.y;
    var av = 0.0; var bv = 0.0;
    if (row < M && ka < K) { av = A[aBase + row * K + ka]; }
    if (kb < K && col < N) { bv = B[bBase + kb * N + col]; }
    As[lid.y][lid.x] = av; Bs[lid.y][lid.x] = bv;
    workgroupBarrier();
    let span = min(16u, K - t);
    for (var k = 0u; k < span; k = k + 1u) { acc = acc + As[lid.y][k] * Bs[k][lid.x]; }
    workgroupBarrier();
  }
  if (row < M && col < N) { O[wg.z * M * N + row * N + col] = acc; }
}`],
  // The same tile, over a weight stored [N, K]: one contiguous row per
  // output column, which is how a checkpoint writes a linear layer.
  matmul_t: [['A', 'B'], `var<workgroup> As: array<array<f32, 16>, 16>;
var<workgroup> Bs: array<array<f32, 16>, 16>;
@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let M = P.g.x; let K = P.g.y; let N = P.g.z;
  let row = wg.y * 16u + lid.y; let col = wg.x * 16u + lid.x;
  let aBase = wg.z * P.sa.x; let bBase = wg.z * P.sa.y;
  var acc = 0.0;
  for (var t = 0u; t < K; t = t + 16u) {
    let ka = t + lid.x; let kb = t + lid.y;
    var av = 0.0; var bv = 0.0;
    if (row < M && ka < K) { av = A[aBase + row * K + ka]; }
    if (kb < K && col < N) { bv = B[bBase + col * K + kb]; }
    As[lid.y][lid.x] = av; Bs[lid.y][lid.x] = bv;
    workgroupBarrier();
    let span = min(16u, K - t);
    for (var k = 0u; k < span; k = k + 1u) { acc = acc + As[lid.y][k] * Bs[k][lid.x]; }
    workgroupBarrier();
  }
  if (row < M && col < N) { O[wg.z * M * N + row * N + col] = acc; }
}`],
  // And over a weight that is still Q4_K blocks: q4k decodes the one value
  // the tile is about to load, so the device holds 144 bytes per 256 weights
  // and never the 1024 they expand to.
  matmul_q4k: [['A', 'B:u32'], `// Block-quantized weights, decoded where they are used.
//
// Ports of dequantize_row_q4_K and dequantize_row_q6_K; src/quant.mjs is the
// same thing in JavaScript and the gguf-quants crate is it in Rust. Addressing is by
// absolute byte, not by word: a Q6_K block is 210 bytes, so blocks after the
// first are not word-aligned and a word-relative accessor would be wrong.
fn qbyte(off: u32) -> u32 { return (B[off >> 2u] >> ((off & 3u) * 8u)) & 0xffu; }
// One f16 from two bytes that may straddle a word.
fn qhalf(off: u32) -> f32 { return unpack2x16float(qbyte(off) | (qbyte(off + 1u) << 8u)).x; }
// Where element e of row col begins, for a format of bytes per 256 values.
fn qbase(block0: u32, col: u32, K: u32, e: u32, bytes: u32) -> u32 {
  return (block0 + col * (K / 256u) + e / 256u) * bytes;
}
// Q4_K: f16 scale and minimum, eight 6-bit sub-block scales and minimums packed
// into 12 bytes, then 256 nibbles. Sub-blocks 0..3 are a plain six bits; 4..7
// borrow their high two bits from the bytes of the first four.
fn q4k_scale_min(base: u32, j: u32) -> vec2<f32> {
  if (j < 4u) { return vec2<f32>(f32(qbyte(base + 4u + j) & 63u), f32(qbyte(base + 8u + j) & 63u)); }
  let hi = qbyte(base + j + 8u);
  let lo = qbyte(base + j);
  let me = qbyte(base + j + 4u);
  return vec2<f32>(f32((hi & 15u) | ((lo >> 6u) << 4u)), f32((hi >> 4u) | ((me >> 6u) << 4u)));
}
fn q4k(block0: u32, col: u32, K: u32, e: u32) -> f32 {
  let base = qbase(block0, col, K, e, 144u);
  let within = e % 256u;
  let pair = within / 64u;
  let rem = within % 64u;
  let byte = qbyte(base + 16u + pair * 32u + rem % 32u);
  let nibble = select(byte >> 4u, byte & 15u, rem < 32u);
  let j = pair * 2u + select(1u, 0u, rem < 32u);
  let sm = q4k_scale_min(base, j);
  return (qhalf(base) * sm.x) * f32(nibble) - qhalf(base + 2u) * sm.y;
}
// Q6_K: 128 low nibbles, 64 bytes of high pairs, sixteen signed group scales,
// then the f16 super-block scale. Each value is (low4 | high2 << 4) - 32.
fn q6k(block0: u32, col: u32, K: u32, e: u32) -> f32 {
  let base = qbase(block0, col, K, e, 210u);
  let within = e % 256u;
  let half = within / 128u;
  let rem = within % 128u;
  let sub = rem / 32u;
  let l = rem % 32u;
  let ql = qbyte(base + 64u * half + l + 32u * (sub & 1u));
  let low = select(ql >> 4u, ql & 15u, sub < 2u);
  let high = (qbyte(base + 128u + 32u * half + l) >> (2u * sub)) & 3u;
  let scale = f32(bitcast<i32>(qbyte(base + 192u + 8u * half + l / 16u + 2u * sub) << 24u) >> 24u);
  return (qhalf(base + 208u) * scale) * f32(bitcast<i32>(low | (high << 4u)) - 32);
}
var<workgroup> As: array<array<f32, 16>, 16>;
var<workgroup> Bs: array<array<f32, 16>, 16>;
@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let M = P.g.x; let K = P.g.y; let N = P.g.z;
  let row = wg.y * 16u + lid.y; let col = wg.x * 16u + lid.x;
  let aBase = wg.z * P.sa.x; let bBase = wg.z * P.sa.y;
  var acc = 0.0;
  for (var t = 0u; t < K; t = t + 16u) {
    let ka = t + lid.x; let kb = t + lid.y;
    var av = 0.0; var bv = 0.0;
    if (row < M && ka < K) { av = A[aBase + row * K + ka]; }
    if (kb < K && col < N) { bv = q4k(bBase / 256u, col, K, kb); }
    As[lid.y][lid.x] = av; Bs[lid.y][lid.x] = bv;
    workgroupBarrier();
    let span = min(16u, K - t);
    for (var k = 0u; k < span; k = k + 1u) { acc = acc + As[lid.y][k] * Bs[k][lid.x]; }
    workgroupBarrier();
  }
  if (row < M && col < N) { O[wg.z * M * N + row * N + col] = acc; }
}`],
  matmul_q6k: [['A', 'B:u32'], `// Block-quantized weights, decoded where they are used.
//
// Ports of dequantize_row_q4_K and dequantize_row_q6_K; src/quant.mjs is the
// same thing in JavaScript and the gguf-quants crate is it in Rust. Addressing is by
// absolute byte, not by word: a Q6_K block is 210 bytes, so blocks after the
// first are not word-aligned and a word-relative accessor would be wrong.
fn qbyte(off: u32) -> u32 { return (B[off >> 2u] >> ((off & 3u) * 8u)) & 0xffu; }
// One f16 from two bytes that may straddle a word.
fn qhalf(off: u32) -> f32 { return unpack2x16float(qbyte(off) | (qbyte(off + 1u) << 8u)).x; }
// Where element e of row col begins, for a format of bytes per 256 values.
fn qbase(block0: u32, col: u32, K: u32, e: u32, bytes: u32) -> u32 {
  return (block0 + col * (K / 256u) + e / 256u) * bytes;
}
// Q4_K: f16 scale and minimum, eight 6-bit sub-block scales and minimums packed
// into 12 bytes, then 256 nibbles. Sub-blocks 0..3 are a plain six bits; 4..7
// borrow their high two bits from the bytes of the first four.
fn q4k_scale_min(base: u32, j: u32) -> vec2<f32> {
  if (j < 4u) { return vec2<f32>(f32(qbyte(base + 4u + j) & 63u), f32(qbyte(base + 8u + j) & 63u)); }
  let hi = qbyte(base + j + 8u);
  let lo = qbyte(base + j);
  let me = qbyte(base + j + 4u);
  return vec2<f32>(f32((hi & 15u) | ((lo >> 6u) << 4u)), f32((hi >> 4u) | ((me >> 6u) << 4u)));
}
fn q4k(block0: u32, col: u32, K: u32, e: u32) -> f32 {
  let base = qbase(block0, col, K, e, 144u);
  let within = e % 256u;
  let pair = within / 64u;
  let rem = within % 64u;
  let byte = qbyte(base + 16u + pair * 32u + rem % 32u);
  let nibble = select(byte >> 4u, byte & 15u, rem < 32u);
  let j = pair * 2u + select(1u, 0u, rem < 32u);
  let sm = q4k_scale_min(base, j);
  return (qhalf(base) * sm.x) * f32(nibble) - qhalf(base + 2u) * sm.y;
}
// Q6_K: 128 low nibbles, 64 bytes of high pairs, sixteen signed group scales,
// then the f16 super-block scale. Each value is (low4 | high2 << 4) - 32.
fn q6k(block0: u32, col: u32, K: u32, e: u32) -> f32 {
  let base = qbase(block0, col, K, e, 210u);
  let within = e % 256u;
  let half = within / 128u;
  let rem = within % 128u;
  let sub = rem / 32u;
  let l = rem % 32u;
  let ql = qbyte(base + 64u * half + l + 32u * (sub & 1u));
  let low = select(ql >> 4u, ql & 15u, sub < 2u);
  let high = (qbyte(base + 128u + 32u * half + l) >> (2u * sub)) & 3u;
  let scale = f32(bitcast<i32>(qbyte(base + 192u + 8u * half + l / 16u + 2u * sub) << 24u) >> 24u);
  return (qhalf(base + 208u) * scale) * f32(bitcast<i32>(low | (high << 4u)) - 32);
}
var<workgroup> As: array<array<f32, 16>, 16>;
var<workgroup> Bs: array<array<f32, 16>, 16>;
@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let M = P.g.x; let K = P.g.y; let N = P.g.z;
  let row = wg.y * 16u + lid.y; let col = wg.x * 16u + lid.x;
  let aBase = wg.z * P.sa.x; let bBase = wg.z * P.sa.y;
  var acc = 0.0;
  for (var t = 0u; t < K; t = t + 16u) {
    let ka = t + lid.x; let kb = t + lid.y;
    var av = 0.0; var bv = 0.0;
    if (row < M && ka < K) { av = A[aBase + row * K + ka]; }
    if (kb < K && col < N) { bv = q6k(bBase / 256u, col, K, kb); }
    As[lid.y][lid.x] = av; Bs[lid.y][lid.x] = bv;
    workgroupBarrier();
    let span = min(16u, K - t);
    for (var k = 0u; k < span; k = k + 1u) { acc = acc + As[lid.y][k] * Bs[k][lid.x]; }
    workgroupBarrier();
  }
  if (row < M && col < N) { O[wg.z * M * N + row * N + col] = acc; }
}`],
  // Split along the reduced axis, then sum the parts.
  //
  // A decode step multiplies [1, 1024] by [2048, 1024]. The tile above is
  // 16 by 16, so fifteen of every sixteen rows in it do nothing and the whole
  // product is 128 workgroups -- far too few to fill a GPU, and measurably
  // slower per weight than one matmul with a hundred times more outputs.
  // Slicing the reduced axis multiplies the workgroups by the slice count,
  // and `reduce` adds the slices back. Within a slice nothing about the
  // arithmetic changes, so quantized still equals decoded here exactly.
  matmul_split: [['A', 'B'], `var<workgroup> As: array<array<f32, 16>, 16>;
var<workgroup> Bs: array<array<f32, 16>, 16>;
@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let M = P.g.x; let K = P.g.y; let N = P.g.z;
  let batches = max(P.g.w, 1u);
  let part = wg.z / batches; let b = wg.z % batches;
  let row = wg.y * 16u + lid.y; let col = wg.x * 16u + lid.x;
  let aBase = b * P.sa.x; let bBase = b * P.sa.y;
  let k0 = part * P.sa.z; let k1 = min(K, k0 + P.sa.z);
  var acc = 0.0;
  for (var t = k0; t < k1; t = t + 16u) {
    let ka = t + lid.x; let kb = t + lid.y;
    var av = 0.0; var bv = 0.0;
    if (row < M && ka < k1) { av = A[aBase + row * K + ka]; }
    if (kb < k1 && col < N) { bv = B[bBase + kb * N + col]; }
    As[lid.y][lid.x] = av; Bs[lid.y][lid.x] = bv;
    workgroupBarrier();
    let span = min(16u, k1 - t);
    for (var k = 0u; k < span; k = k + 1u) { acc = acc + As[lid.y][k] * Bs[k][lid.x]; }
    workgroupBarrier();
  }
  if (row < M && col < N) { O[(part * batches + b) * M * N + row * N + col] = acc; }
}`],
  matmul_t_split: [['A', 'B'], `var<workgroup> As: array<array<f32, 16>, 16>;
var<workgroup> Bs: array<array<f32, 16>, 16>;
@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let M = P.g.x; let K = P.g.y; let N = P.g.z;
  let batches = max(P.g.w, 1u);
  let part = wg.z / batches; let b = wg.z % batches;
  let row = wg.y * 16u + lid.y; let col = wg.x * 16u + lid.x;
  let aBase = b * P.sa.x; let bBase = b * P.sa.y;
  let k0 = part * P.sa.z; let k1 = min(K, k0 + P.sa.z);
  var acc = 0.0;
  for (var t = k0; t < k1; t = t + 16u) {
    let ka = t + lid.x; let kb = t + lid.y;
    var av = 0.0; var bv = 0.0;
    if (row < M && ka < k1) { av = A[aBase + row * K + ka]; }
    if (kb < k1 && col < N) { bv = B[bBase + col * K + kb]; }
    As[lid.y][lid.x] = av; Bs[lid.y][lid.x] = bv;
    workgroupBarrier();
    let span = min(16u, k1 - t);
    for (var k = 0u; k < span; k = k + 1u) { acc = acc + As[lid.y][k] * Bs[k][lid.x]; }
    workgroupBarrier();
  }
  if (row < M && col < N) { O[(part * batches + b) * M * N + row * N + col] = acc; }
}`],
  matmul_q4k_split: [['A', 'B:u32'], `// Block-quantized weights, decoded where they are used.
//
// Ports of dequantize_row_q4_K and dequantize_row_q6_K; src/quant.mjs is the
// same thing in JavaScript and the gguf-quants crate is it in Rust. Addressing is by
// absolute byte, not by word: a Q6_K block is 210 bytes, so blocks after the
// first are not word-aligned and a word-relative accessor would be wrong.
fn qbyte(off: u32) -> u32 { return (B[off >> 2u] >> ((off & 3u) * 8u)) & 0xffu; }
// One f16 from two bytes that may straddle a word.
fn qhalf(off: u32) -> f32 { return unpack2x16float(qbyte(off) | (qbyte(off + 1u) << 8u)).x; }
// Where element e of row col begins, for a format of bytes per 256 values.
fn qbase(block0: u32, col: u32, K: u32, e: u32, bytes: u32) -> u32 {
  return (block0 + col * (K / 256u) + e / 256u) * bytes;
}
// Q4_K: f16 scale and minimum, eight 6-bit sub-block scales and minimums packed
// into 12 bytes, then 256 nibbles. Sub-blocks 0..3 are a plain six bits; 4..7
// borrow their high two bits from the bytes of the first four.
fn q4k_scale_min(base: u32, j: u32) -> vec2<f32> {
  if (j < 4u) { return vec2<f32>(f32(qbyte(base + 4u + j) & 63u), f32(qbyte(base + 8u + j) & 63u)); }
  let hi = qbyte(base + j + 8u);
  let lo = qbyte(base + j);
  let me = qbyte(base + j + 4u);
  return vec2<f32>(f32((hi & 15u) | ((lo >> 6u) << 4u)), f32((hi >> 4u) | ((me >> 6u) << 4u)));
}
fn q4k(block0: u32, col: u32, K: u32, e: u32) -> f32 {
  let base = qbase(block0, col, K, e, 144u);
  let within = e % 256u;
  let pair = within / 64u;
  let rem = within % 64u;
  let byte = qbyte(base + 16u + pair * 32u + rem % 32u);
  let nibble = select(byte >> 4u, byte & 15u, rem < 32u);
  let j = pair * 2u + select(1u, 0u, rem < 32u);
  let sm = q4k_scale_min(base, j);
  return (qhalf(base) * sm.x) * f32(nibble) - qhalf(base + 2u) * sm.y;
}
// Q6_K: 128 low nibbles, 64 bytes of high pairs, sixteen signed group scales,
// then the f16 super-block scale. Each value is (low4 | high2 << 4) - 32.
fn q6k(block0: u32, col: u32, K: u32, e: u32) -> f32 {
  let base = qbase(block0, col, K, e, 210u);
  let within = e % 256u;
  let half = within / 128u;
  let rem = within % 128u;
  let sub = rem / 32u;
  let l = rem % 32u;
  let ql = qbyte(base + 64u * half + l + 32u * (sub & 1u));
  let low = select(ql >> 4u, ql & 15u, sub < 2u);
  let high = (qbyte(base + 128u + 32u * half + l) >> (2u * sub)) & 3u;
  let scale = f32(bitcast<i32>(qbyte(base + 192u + 8u * half + l / 16u + 2u * sub) << 24u) >> 24u);
  return (qhalf(base + 208u) * scale) * f32(bitcast<i32>(low | (high << 4u)) - 32);
}
var<workgroup> As: array<array<f32, 16>, 16>;
var<workgroup> Bs: array<array<f32, 16>, 16>;
@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let M = P.g.x; let K = P.g.y; let N = P.g.z;
  let batches = max(P.g.w, 1u);
  let part = wg.z / batches; let b = wg.z % batches;
  let row = wg.y * 16u + lid.y; let col = wg.x * 16u + lid.x;
  let aBase = b * P.sa.x; let bBase = b * P.sa.y;
  let k0 = part * P.sa.z; let k1 = min(K, k0 + P.sa.z);
  var acc = 0.0;
  for (var t = k0; t < k1; t = t + 16u) {
    let ka = t + lid.x; let kb = t + lid.y;
    var av = 0.0; var bv = 0.0;
    if (row < M && ka < k1) { av = A[aBase + row * K + ka]; }
    if (kb < k1 && col < N) { bv = q4k(bBase / 256u, col, K, kb); }
    As[lid.y][lid.x] = av; Bs[lid.y][lid.x] = bv;
    workgroupBarrier();
    let span = min(16u, k1 - t);
    for (var k = 0u; k < span; k = k + 1u) { acc = acc + As[lid.y][k] * Bs[k][lid.x]; }
    workgroupBarrier();
  }
  if (row < M && col < N) { O[(part * batches + b) * M * N + row * N + col] = acc; }
}`],
  matmul_q6k_split: [['A', 'B:u32'], `// Block-quantized weights, decoded where they are used.
//
// Ports of dequantize_row_q4_K and dequantize_row_q6_K; src/quant.mjs is the
// same thing in JavaScript and the gguf-quants crate is it in Rust. Addressing is by
// absolute byte, not by word: a Q6_K block is 210 bytes, so blocks after the
// first are not word-aligned and a word-relative accessor would be wrong.
fn qbyte(off: u32) -> u32 { return (B[off >> 2u] >> ((off & 3u) * 8u)) & 0xffu; }
// One f16 from two bytes that may straddle a word.
fn qhalf(off: u32) -> f32 { return unpack2x16float(qbyte(off) | (qbyte(off + 1u) << 8u)).x; }
// Where element e of row col begins, for a format of bytes per 256 values.
fn qbase(block0: u32, col: u32, K: u32, e: u32, bytes: u32) -> u32 {
  return (block0 + col * (K / 256u) + e / 256u) * bytes;
}
// Q4_K: f16 scale and minimum, eight 6-bit sub-block scales and minimums packed
// into 12 bytes, then 256 nibbles. Sub-blocks 0..3 are a plain six bits; 4..7
// borrow their high two bits from the bytes of the first four.
fn q4k_scale_min(base: u32, j: u32) -> vec2<f32> {
  if (j < 4u) { return vec2<f32>(f32(qbyte(base + 4u + j) & 63u), f32(qbyte(base + 8u + j) & 63u)); }
  let hi = qbyte(base + j + 8u);
  let lo = qbyte(base + j);
  let me = qbyte(base + j + 4u);
  return vec2<f32>(f32((hi & 15u) | ((lo >> 6u) << 4u)), f32((hi >> 4u) | ((me >> 6u) << 4u)));
}
fn q4k(block0: u32, col: u32, K: u32, e: u32) -> f32 {
  let base = qbase(block0, col, K, e, 144u);
  let within = e % 256u;
  let pair = within / 64u;
  let rem = within % 64u;
  let byte = qbyte(base + 16u + pair * 32u + rem % 32u);
  let nibble = select(byte >> 4u, byte & 15u, rem < 32u);
  let j = pair * 2u + select(1u, 0u, rem < 32u);
  let sm = q4k_scale_min(base, j);
  return (qhalf(base) * sm.x) * f32(nibble) - qhalf(base + 2u) * sm.y;
}
// Q6_K: 128 low nibbles, 64 bytes of high pairs, sixteen signed group scales,
// then the f16 super-block scale. Each value is (low4 | high2 << 4) - 32.
fn q6k(block0: u32, col: u32, K: u32, e: u32) -> f32 {
  let base = qbase(block0, col, K, e, 210u);
  let within = e % 256u;
  let half = within / 128u;
  let rem = within % 128u;
  let sub = rem / 32u;
  let l = rem % 32u;
  let ql = qbyte(base + 64u * half + l + 32u * (sub & 1u));
  let low = select(ql >> 4u, ql & 15u, sub < 2u);
  let high = (qbyte(base + 128u + 32u * half + l) >> (2u * sub)) & 3u;
  let scale = f32(bitcast<i32>(qbyte(base + 192u + 8u * half + l / 16u + 2u * sub) << 24u) >> 24u);
  return (qhalf(base + 208u) * scale) * f32(bitcast<i32>(low | (high << 4u)) - 32);
}
var<workgroup> As: array<array<f32, 16>, 16>;
var<workgroup> Bs: array<array<f32, 16>, 16>;
@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let M = P.g.x; let K = P.g.y; let N = P.g.z;
  let batches = max(P.g.w, 1u);
  let part = wg.z / batches; let b = wg.z % batches;
  let row = wg.y * 16u + lid.y; let col = wg.x * 16u + lid.x;
  let aBase = b * P.sa.x; let bBase = b * P.sa.y;
  let k0 = part * P.sa.z; let k1 = min(K, k0 + P.sa.z);
  var acc = 0.0;
  for (var t = k0; t < k1; t = t + 16u) {
    let ka = t + lid.x; let kb = t + lid.y;
    var av = 0.0; var bv = 0.0;
    if (row < M && ka < k1) { av = A[aBase + row * K + ka]; }
    if (kb < k1 && col < N) { bv = q6k(bBase / 256u, col, K, kb); }
    As[lid.y][lid.x] = av; Bs[lid.y][lid.x] = bv;
    workgroupBarrier();
    let span = min(16u, k1 - t);
    for (var k = 0u; k < span; k = k + 1u) { acc = acc + As[lid.y][k] * Bs[k][lid.x]; }
    workgroupBarrier();
  }
  if (row < M && col < N) { O[(part * batches + b) * M * N + row * N + col] = acc; }
}`],
};
/**
 * A register-blocked matmul: each 16x16 workgroup computes a (16 * tm) x
 * (16 * tn) output tile and each invocation tm x tn of it -- rows
 * 64g + 4 lid.y + q and columns 64h + 4 lid.x + q -- from bk-deep slices of A
 * and B staged in workgroup memory as vec4s of four rows (A) or four columns
 * (B), so one 16-byte load feeds four accumulators. A whole slice is
 * multiplied by straight-line code (no loop counter or index arithmetic
 * between the products), a partial last one by a loop. The arithmetic of every
 * output is the 16x16 kernel's exactly: one `acc = acc + a * b` per k, in
 * ascending k, from zero, and no product past the end of the reduced range
 * (a padded `+ 0 * b` could turn a -0 sum into +0). Only who computes which
 * output, and how the operands reach it, change. Accumulators and the inner
 * loop are straight-line scalars (an array indexed in a loop may stay in
 * indexable memory on Direct3D's FXC), and vectors are only ever written
 * whole (FXC refuses a component written through a runtime index).
 * `transposed`: B is stored [N, K]. `split`: the reduced axis is one slice
 * of `matmul_split`'s (part = wg.z / batches, P.sa.z long).
 */
function tiledMatmul(tm, tn, bk, transposed, split, transA = false, transOut = false) {
  const bm = 16 * tm, bn = 16 * tn, am = bm / 4, an = bn / 4, Q = [0, 1, 2, 3], X = 'xyzw';
  const rows = [...Array(tm).keys()], cols = [...Array(tn).keys()];
  // Output i of the invocation: vec4 group i >> 2, component i & 3.
  const row = i => `${64 * (i >> 2)}u + lid.y * 4u + ${i & 3}u`, col = j => `${64 * (j >> 2)}u + lid.x * 4u + ${j & 3}u`;
  const step = k => `{ ${[...Array(tm / 4).keys()].map(g => `let a${g} = As[${k} * ${am}u + ${16 * g}u + lid.y];`).join(' ')}
      ${[...Array(tn / 4).keys()].map(h => `let b${h} = Bs[${k} * ${an}u + ${16 * h}u + lid.x];`).join(' ')}
      ${rows.flatMap(i => cols.map(j => `c${i}_${j} = c${i}_${j} + a${i >> 2}.${X[i & 3]} * b${j >> 2}.${X[j & 3]};`)).join(' ')} }`;
  // One vec4 each per 256 invocations: four rows of A at one k, four columns of B at one k.
  // transA: A holds the [K, M] transpose; consecutive invocations take
  // consecutive rows, so its reads run along its rows.
  const loadA = transA
    ? `let r4 = e % ${am}u; let kk = e / ${am}u; let gk = t + kk; let gr = row0 + r4 * 4u;
      ${Q.map(q => `var v${q} = 0.0; if (gr + ${q}u < M && gk < k1) { v${q} = A[aBase + gk * M + gr + ${q}u]; }`).join(' ')}
      As[kk * ${am}u + r4] = vec4<f32>(v0, v1, v2, v3);`
    : `let kk = e % ${bk}u; let r4 = e / ${bk}u; let gk = t + kk; let gr = row0 + r4 * 4u;
      ${Q.map(q => `var v${q} = 0.0; if (gr + ${q}u < M && gk < k1) { v${q} = A[aBase + (gr + ${q}u) * K + gk]; }`).join(' ')}
      As[kk * ${am}u + r4] = vec4<f32>(v0, v1, v2, v3);`;
  const loadB = transposed
    ? `let kk = e % ${bk}u; let c4 = e / ${bk}u; let gk = t + kk; let gc = col0 + c4 * 4u;
      ${Q.map(q => `var v${q} = 0.0; if (gc + ${q}u < N && gk < k1) { v${q} = B[bBase + (gc + ${q}u) * K + gk]; }`).join(' ')}
      Bs[kk * ${an}u + c4] = vec4<f32>(v0, v1, v2, v3);`
    : `let c4 = e % ${an}u; let kk = e / ${an}u; let gk = t + kk; let gc = col0 + c4 * 4u;
      ${Q.map(q => `var v${q} = 0.0; if (gc + ${q}u < N && gk < k1) { v${q} = B[bBase + gk * N + gc + ${q}u]; }`).join(' ')}
      Bs[kk * ${an}u + c4] = vec4<f32>(v0, v1, v2, v3);`;
  return [['A', 'B'], `var<workgroup> As: array<vec4<f32>, ${bk * am}>;
var<workgroup> Bs: array<vec4<f32>, ${bk * an}>;
@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let M = P.g.x; let K = P.g.y; let N = P.g.z;
  ${split ? `let batches = max(P.g.w, 1u); let part = wg.z / batches; let b = wg.z % batches;
  let k0 = part * P.sa.z; let k1 = min(K, k0 + P.sa.z); let outBase = (part * batches + b) * M * N;`
    : 'let b = wg.z; let k0 = 0u; let k1 = K; let outBase = b * M * N;'}
  let row0 = wg.y * ${bm}u; let col0 = wg.x * ${bn}u;
  let aBase = b * P.sa.x; let bBase = b * P.sa.y;
  ${rows.flatMap(i => cols.map(j => `var c${i}_${j} = 0.0;`)).join(' ')}
  for (var t = k0; t < k1; t = t + ${bk}u) {
    for (var i = 0u; i < ${bk * am / 256}u; i = i + 1u) {
      let e = li + i * 256u; ${loadA}
    }
    for (var i = 0u; i < ${bk * an / 256}u; i = i + 1u) {
      let e = li + i * 256u; ${loadB}
    }
    workgroupBarrier();
    let span = min(${bk}u, k1 - t);
    if (span == ${bk}u) {
      ${[...Array(bk).keys()].map(k => step(`${k}u`)).join('\n      ')}
    } else {
      for (var k = 0u; k < span; k = k + 1u) ${step('k')}
    }
    workgroupBarrier();
  }
  ${rows.flatMap(i => cols.map(j => `{ let r = row0 + ${row(i)}; let c = col0 + ${col(j)}; if (r < M && c < N) { O[outBase + ${transOut ? 'c * M + r' : 'r * N + c'}] = c${i}_${j}; } }`)).join('\n  ')}
}`];
}
/**
 * The 16x16 kernel with A read through its [K, M] transpose (`transA`) and/or
 * the output written as its [N, M] transpose (`transOut`): the same
 * products summed in the same order, only addressed differently. A's tile
 * is loaded along the transpose's rows and stored where the plain kernel
 * stores it. The four plain combinations are the hand-written kernels above.
 */
function baseMatmul(transB, split, transA, transOut) {
  return [['A', 'B'], `var<workgroup> As: array<array<f32, 16>, 16>;
var<workgroup> Bs: array<array<f32, 16>, 16>;
@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let M = P.g.x; let K = P.g.y; let N = P.g.z;
  ${split ? `let batches = max(P.g.w, 1u);
  let part = wg.z / batches; let b = wg.z % batches;
  let k0 = part * P.sa.z; let k1 = min(K, k0 + P.sa.z); let outBase = (part * batches + b) * M * N;`
    : 'let b = wg.z; let k0 = 0u; let k1 = K; let outBase = b * M * N;'}
  let row = wg.y * 16u + lid.y; let col = wg.x * 16u + lid.x;
  let aBase = b * P.sa.x; let bBase = b * P.sa.y;
  var acc = 0.0;
  for (var t = k0; t < k1; t = t + 16u) {
    let ka = t + lid.x; let kb = t + lid.y;
    var av = 0.0; var bv = 0.0;
    ${transA ? `let arow = wg.y * 16u + lid.x;
    if (arow < M && kb < k1) { av = A[aBase + kb * M + arow]; }
    As[lid.x][lid.y] = av;` : `if (row < M && ka < k1) { av = A[aBase + row * K + ka]; }
    As[lid.y][lid.x] = av;`}
    if (kb < k1 && col < N) { bv = B[bBase + ${transB ? 'col * K + kb' : 'kb * N + col'}]; }
    Bs[lid.y][lid.x] = bv;
    workgroupBarrier();
    let span = min(16u, k1 - t);
    for (var k = 0u; k < span; k = k + 1u) { acc = acc + As[lid.y][k] * Bs[k][lid.x]; }
    workgroupBarrier();
  }
  if (row < M && col < N) { O[outBase + ${transOut ? 'col * M + row' : 'row * N + col'}] = acc; }
}`];
}
/**
 * The 16x16 kernel with a deeper slice of the reduced axis staged per step
 * (`bk` values, loaded `bk / 16` per invocation): a small product -- a
 * layer of a small model, a split-K slice -- waits on global memory once per
 * slice, so it waits `bk / 16` times less often. Each output still adds its
 * products one at a time in ascending k from zero, and none past the end of
 * the range. Operands are loaded along their rows (transposes included).
 */
const DEEP_K = 64;
function deepMatmul(transB, split, transA, transOut, bk, epilogue = null) {
  const reps = [...Array(bk / 16).keys()];
  const loadA = transA
    ? reps.map(q => `{ let kb = t + lid.y + ${16 * q}u; var av = 0.0; if (arow < M && kb < k1) { av = A[aBase + kb * M + arow]; } As[lid.x][lid.y + ${16 * q}u] = av; }`)
    : reps.map(q => `{ let ka = t + lid.x + ${16 * q}u; var av = 0.0; if (row < M && ka < k1) { av = A[aBase + row * K + ka]; } As[lid.y][lid.x + ${16 * q}u] = av; }`);
  const loadB = transB
    ? reps.map(q => `{ let kb = t + lid.x + ${16 * q}u; var bv = 0.0; if (kb < k1 && bcol < N) { bv = B[bBase + bcol * K + kb]; } Bs[lid.x + ${16 * q}u][lid.y] = bv; }`)
    : reps.map(q => `{ let kb = t + lid.y + ${16 * q}u; var bv = 0.0; if (kb < k1 && col < N) { bv = B[bBase + kb * N + col]; } Bs[lid.y + ${16 * q}u][lid.x] = bv; }`);
  return [['A', 'B'], `${epilogue ? CHAIN_FNS : ''}
var<workgroup> As: array<array<f32, ${bk}>, 16>;
var<workgroup> Bs: array<array<f32, 16>, ${bk}>;
@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let M = P.g.x; let K = P.g.y; let N = P.g.z;
  ${split ? `let batches = max(P.g.w, 1u);
  let part = wg.z / batches; let b = wg.z % batches;
  let k0 = part * P.sa.z; let k1 = min(K, k0 + P.sa.z); let outBase = (part * batches + b) * M * N;`
    : 'let b = wg.z; let k0 = 0u; let k1 = K; let outBase = b * M * N;'}
  let row = wg.y * 16u + lid.y; let col = wg.x * 16u + lid.x;
  let arow = wg.y * 16u + lid.x; let bcol = wg.x * 16u + lid.y;
  let aBase = b * P.sa.x; let bBase = b * P.sa.y;
  var acc = 0.0;
  for (var t = k0; t < k1; t = t + ${bk}u) {
    ${loadA.join('\n    ')}
    ${loadB.join('\n    ')}
    workgroupBarrier();
    let span = min(${bk}u, k1 - t);
    if (span == ${bk}u) {
      ${[...Array(bk).keys()].map(k => `acc = acc + As[lid.y][${k}u] * Bs[${k}u][lid.x];`).join(' ')}
    } else {
      for (var k = 0u; k < span; k = k + 1u) { acc = acc + As[lid.y][k] * Bs[k][lid.x]; }
    }
    workgroupBarrier();
  }
  if (row < M && col < N) { ${epilogue ? `let i = row * N + col; let mmv = opaque(acc);
    ${epilogue.join('\n    ')}` : `O[outBase + ${transOut ? 'col * M + row' : 'row * N + col'}] = acc;`} }
}`];
}
// Vectorised elementwise kernels (`each4`): { vec4: true } marks their
// bindings as vec4 arrays sized to whole vec4s.
const VEC4 = {vec4: true};
Object.assign(KERNELS, {
  fill4: [[], each4('O[i] = vec4<f32>(P.f.x);'), ['O'], VEC4],
  unary4: [['A'], `${UNARY_LANE}\n${each4(`let x = A[i]; O[i] = ${lanes(c => `un(x.${c})`)};`)}`, ['O'], VEC4],
  // Modes 0 (same shape), 1 (a is a scalar), 2 (b is a scalar).
  binary4: [['A', 'B'], each4(`var a: vec4<f32>; var b: vec4<f32>;
  if (P.mode == 1u) { a = vec4<f32>(A[0].x); } else { a = A[i]; }
  if (P.mode == 2u) { b = vec4<f32>(B[0].x); } else { b = B[i]; }
  O[i] = ${lanes(c => `binop(P.op, a.${c}, b.${c})`)};`), ['O'], VEC4],
  optim4: [['A', 'B', 'C'], `${OPTIM_LANE}\n${each4(`let a = A[i]; let b = B[i]; let c = C[i]; O[i] = ${lanes(k => `opt(a.${k}, b.${k}, c.${k})`)};`)}`, ['O'], VEC4],
  adam4: [['W', 'Mi', 'Vi', 'G'], `${ADAM_LANE}\n${each4(`let a = Mi[i]; let g = G[i]; let vv = Vi[i]; let p = W[i];
  let x = adam1(a.x, g.x, vv.x, p.x); let y = adam1(a.y, g.y, vv.y, p.y); let z = adam1(a.z, g.z, vv.z, p.z); let w = adam1(a.w, g.w, vv.w, p.w);
  O[i] = vec4<f32>(x.x, y.x, z.x, w.x); O2[i] = vec4<f32>(x.y, y.y, z.y, w.y); O3[i] = vec4<f32>(x.z, y.z, z.z, w.z);`)}`, ['O', 'O2', 'O3'], VEC4],
  // Two parameters' in-place Adam passes in one dispatch (fusion's `adam2`
  // groups): the first P.n values (O, O2, O3 from G), then P.len values
  // (O4, O5, O6 from G2), each element as adam_inplace4 computes it.
  adam_pair_inplace4: [['G', 'G2'], `${ADAM_LANE}\n${ADAM_LANE_B}\n@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let i = flat(gid, nwg);
  let na = (P.n + 3u) / 4u;
  if (i < na) {
    let a = O[i]; let g = G[i]; let vv = O2[i]; let p = O3[i];
    let x = adam1(a.x, g.x, vv.x, p.x); let y = adam1(a.y, g.y, vv.y, p.y); let z = adam1(a.z, g.z, vv.z, p.z); let w = adam1(a.w, g.w, vv.w, p.w);
    O[i] = vec4<f32>(x.x, y.x, z.x, w.x); O2[i] = vec4<f32>(x.y, y.y, z.y, w.y); O3[i] = vec4<f32>(x.z, y.z, z.z, w.z);
    return;
  }
  let j = i - na;
  if (j >= (P.len + 3u) / 4u) { return; }
  let a = O4[j]; let g = G2[j]; let vv = O5[j]; let p = O6[j];
  let x = adam1b(a.x, g.x, vv.x, p.x); let y = adam1b(a.y, g.y, vv.y, p.y); let z = adam1b(a.z, g.z, vv.z, p.z); let w = adam1b(a.w, g.w, vv.w, p.w);
  O4[j] = vec4<f32>(x.x, y.x, z.x, w.x); O5[j] = vec4<f32>(x.y, y.y, z.y, w.y); O6[j] = vec4<f32>(x.z, y.z, z.z, w.z);
}`, ['O', 'O2', 'O3', 'O4', 'O5', 'O6'], VEC4],
  adam_inplace4: [['G'], `${ADAM_LANE}\n${each4(`let a = O[i]; let g = G[i]; let vv = O2[i]; let p = O3[i];
  let x = adam1(a.x, g.x, vv.x, p.x); let y = adam1(a.y, g.y, vv.y, p.y); let z = adam1(a.z, g.z, vv.z, p.z); let w = adam1(a.w, g.w, vv.w, p.w);
  O[i] = vec4<f32>(x.x, y.x, z.x, w.x); O2[i] = vec4<f32>(x.y, y.y, z.y, w.y); O3[i] = vec4<f32>(x.z, y.z, z.z, w.z);`)}`, ['O', 'O2', 'O3'], VEC4],
});
// Register-blocked variants of the float matmul kernels: `_r4`, 64x64 tiles,
// 16 deep, and `_r8`, 128x128 tiles 32 deep (64 accumulators an invocation,
// 32 KB of workgroup memory). On an RTX 5090 (Vulkan), 4096^3: 37 and 48
// TFLOP/s (the 64x64 tile with a loop over k: 34). Double-buffered k-slices
// measured no faster; a 32-deep 64x64 tile is 15% faster on 1024^3 but
// takes DXC 7 s to compile. See `tileFor` for which a product uses.
for (const transposed of [false, true])
  for (const split of [false, true])
    for (const transA of [false, true])
      for (const transOut of split ? [false] : [false, true]) {
        const name = matmulName(transposed, transA, transOut, split);
        KERNELS[`${name}_r4`] = tiledMatmul(4, 4, 16, transposed, split, transA, transOut);
        KERNELS[`${name}_r8`] = tiledMatmul(8, 8, 32, transposed, split, transA, transOut);
        if (transA || transOut) KERNELS[name] = baseMatmul(transposed, split, transA, transOut);
        KERNELS[`${name}_d`] = deepMatmul(transposed, split, transA, transOut, DEEP_K);
      }
/** A float matmul kernel's name: `_t` B stored [N, K], `_ta` A read through
 * its transpose, `_to` the output written transposed, `_split` a K slice. */
function matmulName(transB, transA, transOut, split) {
  return `matmul${transB ? '_t' : ''}${transA ? '_ta' : ''}${transOut ? '_to' : ''}${split ? '_split' : ''}`;
}
const UNARY = {relu: 0, positive: 1, neg: 2, exp: 3, log: 4, sqrt: 5, tanh: 6, sigmoid: 7, gelu: 8, gelu_grad: 9};
const BINARY = {add: 0, sub: 1, mul: 2, div: 3, maximum: 4, minimum: 5, eq: 6, ne: 7, lt: 8, le: 9, gt: 10, ge: 11};
const MODE = {same: 0, aScalar: 1, bScalar: 2, general: 3};
const OPTIM = {sgd_update: 0, momentum_update: 1, adam_m: 2, adam_v: 3, adam_update: 4};
// One 256-byte uniform slot per dispatch in a single buffer (dynamic offsets),
// so a bind group depends only on its kernel and storage buffers and is
// reused across steps and runs. UNIFORM_SLOTS bounds the dispatches of one
// submission (a 64-step session run of a 512-node graph fits).
// Enough outputs to fill a GPU, and the smallest slice of the reduced axis
// worth a pass of its own. Round numbers: the win is the order of magnitude.
const WIDE_ENOUGH = 65536, MIN_SPLIT_K = 512, MIN_SPLIT_CHUNK = 128, MAX_SPLIT = 32;
// Workgroups a register-blocked matmul tile must produce to be chosen, and
// the workgroup memory of the 128x128 one.
const TILE_GROUPS = 256, BIG_TILE_BYTES = 32768;
const SLOT = 256, UNIFORM_SLOTS = 16384, POOL_BYTES = 256 * 1024 * 1024, GROUP_CACHE = 8192;
const COMPUTE = () => globalThis.GPUShaderStage?.COMPUTE ?? 4;
/** Blocks as whole four-byte words. A Q6_K block is 210 bytes, so a buffer of
 * them need not be a multiple of four and the tail is padded rather than
 * read short. */
const words = bytes => {
  const total = Math.ceil(bytes.byteLength / 4) * 4;
  const padded = total === bytes.byteLength ? bytes : (() => { const b = new Uint8Array(total); b.set(bytes); return b; })();
  return new Uint32Array(padded.buffer, padded.byteOffset, total / 4);
};

export class WebGPUBackend {
  static async create({debug = false} = {}) {
    check(globalThis.navigator?.gpu, 'UNAVAILABLE', 'WebGPU is unavailable (use HTTPS or localhost)');
    const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
    check(adapter, 'UNAVAILABLE', 'No WebGPU adapter is available');
    check(!(adapter.info?.isFallbackAdapter ?? adapter.isFallbackAdapter), 'UNAVAILABLE', 'Hardware WebGPU required; browser returned a fallback adapter');
    // Ask for the storage sizes the adapter supports (bounded), not the portable
    // minimum, and the workgroup memory the 128x128 matmul tile needs.
    const requiredLimits = {};
    for (const key of ['maxStorageBufferBindingSize', 'maxBufferSize'])
      if (adapter.limits?.[key]) requiredLimits[key] = Math.min(adapter.limits[key], 1024 * 1024 * 1024);
    if (adapter.limits?.maxComputeWorkgroupStorageSize >= BIG_TILE_BYTES) requiredLimits.maxComputeWorkgroupStorageSize = BIG_TILE_BYTES;
    const device = await adapter.requestDevice({requiredLimits});
    return new WebGPUBackend(device, adapter.info, {debug});
  }
  constructor(device, info, {debug = false} = {}) {
    this.name = 'webgpu'; this.description = 'WebGPU compute shaders (WGSL)';
    this.device = device; this.debug = debug; this.info = info ? {vendor: info.vendor, architecture: info.architecture,
      description: info.description, isFallbackAdapter: info.isFallbackAdapter ?? null} : null;
    this.pipelines = new Map(); this.lost = null; this.scopeOpen = false; this.matmulTile = null;
    this.bigTiles = (device.limits?.maxComputeWorkgroupStorageSize ?? 0) >= BIG_TILE_BYTES;
    this.deep = true;
    // Adam groups in one pass (`adam`); false keeps three (tests compare the bits).
    this.fuseAdam = true;
    // Transposes read through by matmuls and one-dispatch reductions; false
    // runs every node as its own kernel (tests compare the bits).
    this.fuse = true;
    // Elementwise kernels four elements an invocation (`each4`); false keeps
    // the one-element kernels (tests compare the bits).
    this.vectorize = true;
    // Idle bytes kept for reuse; a host with device memory to spare raises it.
    this.poolBytes = POOL_BYTES;
    // Idle buffers are free across executions; recycled ones were freed during the
    // current one and may still be read by commands recorded before the free.
    this.idle = new Map(); this.recycled = []; this.idleBytes = 0;
    this.groups = new Map(); this.bufferIds = new WeakMap(); this.nextBufferId = 1;
    this.uniformBuffer = null; this.uniformData = new ArrayBuffer(UNIFORM_SLOTS * SLOT); this.slot = 0;
    this.uniformWords = new Uint32Array(this.uniformData);
    this.scratchU = new Uint32Array(24); this.scratchF = new Float32Array(this.scratchU.buffer);
    this.staging = null; this.encoder = null; this.pass = null;
    this.peakBufferBytes = 0; this.liveBufferBytes = 0;
    device.lost.then(reason => {this.lost = reason.message || reason.reason || 'Device lost';});
  }
  live() { check(!this.lost, 'DEVICE_LOST', `WebGPU device is unavailable: ${this.lost}`); }
  limitHints() {
    const cap = Math.floor(Math.min(this.device.limits.maxStorageBufferBindingSize, this.device.limits.maxBufferSize) / 4);
    return {maxElements: Math.min(DEFAULT_LIMITS.maxElements, cap), maxWork: 1000000000};
  }
  allocationStats() { return {webgpuBufferPeakBytes: this.peakBufferBytes}; }
  /** Integer accumulation needs 64 bits -- products reach 2^30 and their sums
   * 2^40 -- and WGSL has no 64-bit integer type. Until that is emulated in
   * paired u32s, this backend says so rather than returning zeros. See
   * docs/FIXED-POINT.md. */
  unsupported(){return UNSUPPORTED;}
  async begin() {
    this.live(); this.device.pushErrorScope('out-of-memory'); this.device.pushErrorScope('validation');
    this.scopeOpen = true; this.slot = 0;
    if (!this.uniformBuffer) this.uniformBuffer = this.device.createBuffer({size: UNIFORM_SLOTS * SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
  }
  idOf(buffer) { let id = this.bufferIds.get(buffer); if (!id) { id = this.nextBufferId++; this.bufferIds.set(buffer, id); } return id; }
  bytesFor(size) { return Math.max(SLOT, Math.ceil(size * 4 / SLOT) * SLOT); }
  alloc(size, data) {
    this.live();
    check(size * 4 <= this.device.limits.maxStorageBufferBindingSize && size * 4 <= this.device.limits.maxBufferSize,
      'LIMIT', 'Tensor exceeds WebGPU buffer limits');
    const bytes = this.bytesFor(size), list = this.idle.get(bytes);
    let buffer;
    // A buffer freed during this execution is safe for outputs only: a queue write
    // would land before commands recorded earlier in the pending encoder. Outputs
    // take those first, so idle buffers stay for the uploads of later steps.
    if (!data) { const i = this.recycled.findIndex(b => b.bytes === bytes); if (i >= 0) buffer = this.recycled.splice(i, 1)[0].buffer; }
    if (!buffer) { buffer = list?.pop(); if (buffer) this.idleBytes -= bytes; }
    if (buffer) {
      if (data) this.device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, size * 4);
    } else {
      buffer = this.device.createBuffer({size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        mappedAtCreation: !!data});
      if (data) {
        const view = data instanceof Uint32Array
          ? new Uint32Array(buffer.getMappedRange(), 0, size)
          : new Float32Array(buffer.getMappedRange(), 0, size);
        view.set(data); buffer.unmap();
      }
      this.liveBufferBytes += bytes; this.peakBufferBytes = Math.max(this.peakBufferBytes, this.liveBufferBytes);
    }
    return {buffer, size, bytes, freed: false};
  }
  /** One pipeline per kernel with an explicit layout: a dynamic-offset uniform, read-only inputs, one output. */
  async pipeline(name) {
    let entry = this.pipelines.get(name);
    if (!entry) {
      const [inputs, body, outputs = ['O'], options = {}] = KERNELS[name];
      const layout = this.device.createBindGroupLayout({entries: [
        {binding: 0, visibility: COMPUTE(), buffer: {type: 'uniform', hasDynamicOffset: true}},
        ...inputs.map((_, i) => ({binding: i + 1, visibility: COMPUTE(), buffer: {type: 'read-only-storage'}})),
        ...outputs.map((_, i) => ({binding: inputs.length + 1 + i, visibility: COMPUTE(), buffer: {type: 'storage'}}))]});
      const module = this.device.createShaderModule({code: `${PRELUDE}\n${io(inputs, outputs, options.vec4)}\n${body}`});
      const pipeline = await this.device.createComputePipelineAsync({label: name, layout: this.device.createPipelineLayout({bindGroupLayouts: [layout]}),
        compute: {module, entryPoint: 'main'}});
      entry = {pipeline, layout, vec4: !!options.vec4, threads: options.threads ?? 256}; this.pipelines.set(name, entry);
    }
    return entry;
  }
  /** How many ways to slice a product's reduced axis, or null to leave it whole.
   *
   * The tile is 16 by 16, so a product with one row uses a sixteenth of each
   * workgroup and a few thousand outputs make only a hundred groups. The slice
   * is a multiple of 16 so every slice starts where a tile does. */
  splitParts(n) {
    if (n.size >= WIDE_ENOUGH || n.k < MIN_SPLIT_K) return null;
    const want = Math.min(Math.ceil(WIDE_ENOUGH / n.size), MAX_SPLIT);
    const chunk = Math.max(MIN_SPLIT_CHUNK, Math.ceil(Math.ceil(n.k / want) / 16) * 16);
    const parts = Math.ceil(n.k / chunk);
    return parts > 1 ? {parts, chunk} : null;
  }
  /**
   * Outputs per invocation along each side of a float matmul's workgroup
   * tile: 8 (128x128 tiles) or 4 (64x64) when a product is at least a tile
   * wide and tall and has enough of them to fill the GPU, the larger first
   * (where the device has its workgroup memory), else 1 (the 16x16 kernel,
   * the most workgroups for a small product). Every tile computes every
   * output with the same additions in the same order.
   * `matmulTile` pins it: tests compare the tiles' bits, and a host whose
   * shader compiler is slow on the large tile (FXC) keeps 1.
   */
  tileFor(m, n, z) {
    if (this.matmulTile) return this.matmulTile;
    // A product narrower than a tile (a decode step's single row) would leave
    // most of each 64x64 tile idle: it keeps the 16x16 kernel and split-K.
    const fills = side => m >= side && n >= side && Math.ceil(m / side) * Math.ceil(n / side) * z >= TILE_GROUPS;
    if (this.bigTiles && fills(128)) return 8;
    return fills(64) ? 4 : 1;
  }
  /** Fills the next 256-byte uniform slot and returns its dynamic offset; slots upload once, at submit. */
  uniform(fill) {
    check(this.slot < UNIFORM_SLOTS, 'LIMIT', `One submission dispatches at most ${UNIFORM_SLOTS} kernels; run fewer steps at a time`);
    // Filled through two fixed views of one 96-byte scratch block, then
    // copied into the slot: no typed-array views made per dispatch.
    const offset = this.slot++ * SLOT, u = this.scratchU;
    u.fill(0); fill(u, this.scratchF); this.uniformWords.set(u, offset / 4);
    return offset;
  }
  /** Bind groups are cached by kernel and storage buffers: fixed buffers (a session's) never rebuild one. */
  bindGroup(kernel, layout, handles, vec4 = false) {
    let key = kernel;
    for (const h of handles) key += h.key ??= `|${this.idOf(h.buffer)}:${h.size}`;
    let group = this.groups.get(key);
    if (!group) {
      if (this.groups.size >= GROUP_CACHE) this.groups.clear();
      // A vec4 kernel binds whole vec4s (within the buffer's 256-byte blocks).
      group = this.device.createBindGroup({layout, entries: [{binding: 0, resource: {buffer: this.uniformBuffer, offset: 0, size: 96}},
        ...handles.map((h, i) => ({binding: i + 1, resource: {buffer: h.buffer, size: vec4 ? Math.ceil(h.size / 4) * 16 : h.size * 4}}))]});
      this.groups.set(key, group);
    }
    return group;
  }
  async dispatch(kernel, fill, inputs, out, count, groups = null) {
    this.live();
    const {pipeline, layout, vec4, threads} = this.pipelines.get(kernel) ?? await this.pipeline(kernel), limit = this.device.limits.maxComputeWorkgroupsPerDimension;
    let [x, y, z] = groups ?? [Math.ceil((vec4 ? Math.ceil(count / 4) : count) / threads), 1, 1];
    if (!groups && x > limit) { y = Math.ceil(x / limit); x = limit; }
    check(x <= limit && y <= limit && z <= limit, 'LIMIT', 'Dispatch exceeds WebGPU workgroup limit');
    const offset = this.uniform(fill), group = this.bindGroup(kernel, layout, [...inputs, ...(Array.isArray(out) ? out : [out])], vec4);
    if (!this.encoder) this.encoder = this.device.createCommandEncoder();
    if (!this.pass) this.pass = this.encoder.beginComputePass();
    this.pass.setPipeline(pipeline); this.pass.setBindGroup(0, group, [offset]); this.pass.dispatchWorkgroups(x, y, z);
  }
  /**
   * One parameter's Adam group (graph.mjs adamGroups) in one dispatch: new
   * m, v and p from the old ones and the gradient, into fresh buffers, or
   * into `inPlace` (the held m, v and p a session carries them back into).
   * Of the update's refs only p is read; its m and v are this pass's own.
   */
  async adam(m, v, u, [mIn, g], [vIn], [p], inPlace = null) {
    this.live();
    const outs = inPlace ?? [this.alloc(u.size), this.alloc(u.size), this.alloc(u.size)];
    const fill = (w, f) => {w[0] = u.size; f[12] = m.w; f[13] = v.beta2; f[14] = v.w; f.set([u.stepSize, u.bc2Sqrt, u.eps], 20);};
    let scoped = this.debug;
    if (scoped) this.device.pushErrorScope('validation');
    try {
      const v4 = this.vectorize ? '4' : '';
      if (inPlace) await this.dispatch(`adam_inplace${v4}`, fill, [g], outs, u.size);
      else await this.dispatch(`adam${v4}`, fill, [p, mIn, vIn, g], outs, u.size);
      if (scoped) {
        scoped = false;
        const error = await this.device.popErrorScope();
        check(!error, 'GPU', `adam: ${error?.message}`);
      }
      return outs;
    } catch (error) {
      if (scoped) await this.device.popErrorScope().catch(() => {});
      if (!inPlace) for (const h of outs) this.free(h);
      throw error;
    }
  }
  /**
   * Two Adam groups updating in place (`adam2`), in one dispatch: each
   * parameter's elements computed exactly as `adam` computes them. `gA`,
   * `gB` the gradients; `ipA`, `ipB` the held m, v and p of each.
   */
  async adamPair(A, B, gA, gB, ipA, ipB, stepped) {
    this.live();
    const [mA, vA, uA, mB, vB, uB] = [A.M, A.V, A.U, B.M, B.V, B.U].map(stepped);
    const fill = (w, f) => {
      w[0] = uA.size; w[3] = uB.size;
      f[12] = mA.w; f[13] = vA.beta2; f[14] = vA.w; f.set([uA.stepSize, uA.bc2Sqrt, uA.eps], 20);
      f[4] = mB.w; f[5] = vB.beta2; f[6] = vB.w; f.set([uB.stepSize, uB.bc2Sqrt, uB.eps], 8);
    };
    let scoped = this.debug;
    if (scoped) this.device.pushErrorScope('validation');
    try {
      await this.dispatch('adam_pair_inplace4', fill, [gA, gB], [...ipA, ...ipB], (Math.ceil(uA.size / 4) + Math.ceil(uB.size / 4)) * 4);
      if (scoped) {
        scoped = false;
        const error = await this.device.popErrorScope();
        check(!error, 'GPU', `adam: ${error?.message}`);
      }
      return [...ipA, ...ipB];
    } catch (error) {
      if (scoped) await this.device.popErrorScope().catch(() => {});
      throw error;
    }
  }
  /**
   * One matmul: A (read through its transpose with `transA`), B (stored
   * [N, K] with `transB`), into `out` (written transposed with `transOut`).
   * The tile, the addressing and a split of K change who computes an output
   * and where its operands come from, never the sum each output is.
   */
  async matmul(n, refs, out, transB, transA, transOut) {
    const kernel = n.bQuant ? `matmul_${n.bQuant.dtype.replace('_', '')}` : matmulName(transB, transA, transOut, false);
    const split = transOut ? null : this.splitParts(n);
    const tile = n.bQuant ? 1 : this.tileFor(n.m, n.n, n.batch * (split ? split.parts : 1)), side = 16 * tile;
    // The 16x16 kernel's deep-slice variant (`deepMatmul`) unless pinned off.
    const suffix = tile !== 1 ? `_r${tile}` : this.deep !== false && !n.bQuant ? '_d' : '';
    if (!split) {
      await this.dispatch(kernel + suffix, u => {u.set([n.m, n.k, n.n, n.batch], 16); u[8] = n.aBatchStride; u[9] = n.bBatchStride;},
        refs, out, n.size, [Math.ceil(n.n / side), Math.ceil(n.m / side), n.batch]);
      return;
    }
    const {parts, chunk} = split, partials = this.alloc(n.size * parts);
    const name = n.bQuant ? `${kernel}_split` : matmulName(transB, transA, false, true);
    try {
      await this.dispatch(`${name}${suffix}`, u => {
        u.set([n.m, n.k, n.n, n.batch], 16);
        u[8] = n.aBatchStride; u[9] = n.bBatchStride; u[10] = chunk;
      }, refs, partials, n.size * parts, [Math.ceil(n.n / side), Math.ceil(n.m / side), n.batch * parts]);
      // `reduce` sums a [parts, outputs] layout straight down the parts.
      await this.dispatch('reduce', u => {u[0] = n.size; u[1] = 0; u[3] = parts; u[16] = n.size;},
        [partials], out, n.size);
    } finally { this.free(partials); }
  }
  /** What the fusion plan depends on besides the plan (fusion.mjs caches by it). */
  fusionKey() { return `${this.fuse !== false}|${this.fuseAdam !== false}|${this.matmulTile}|${this.deep !== false}|${this.bigTiles}`; }
  /**
   * The groups this backend computes together (fusion.mjs): Adam's three
   * updates of a parameter (one pass), and a 2-D matmul reading an operand
   * that is only a transpose -- or writing a result only a transpose reads --
   * through the transpose's addressing instead of a transpose pass. A
   * transpose is elided only when every consumer reads through it this way.
   */
  fusion(plan, {live}) {
    const nodes = plan.nodes, root = plan.root, groups = [], elided = new Set();
    if (this.fuseAdam !== false) for (const [at, g] of plan.adam) {
      if (!live[g.u]) continue;
      const M = nodes[g.m], V = nodes[g.v], U = nodes[g.u];
      groups.push({kind: 'adam', id: at, group: g, M, V, U, refs: [...M.refs, ...V.refs, U.refs[0]], exposed: [g.m, g.v, g.u]});
      for (const id of [g.m, g.v, g.u]) if (id !== at) elided.add(id);
    }
    if (this.fuse === false) return {groups, elided};
    const consumers = nodes.map(() => []), outputs = new Set(plan.outputs.map(o => root[o.id]));
    for (const n of nodes) if (live[n.id] && !n.alias) for (const r of n.refs) consumers[root[r]].push([n.id, r]);
    // Adam groups two by two (`adam2`): run where the later one stands, as
    // one dispatch when both update in place. The earlier one's results
    // must not be read before then.
    const adams = groups.filter(g => g.kind === 'adam').sort((a, b) => a.id - b.id);
    for (let k = 0; k + 1 < adams.length; k += 2) {
      const [A, B] = [adams[k], adams[k + 1]];
      if (!A.exposed.every(id => consumers[id].every(([c]) => c > B.id || A.exposed.includes(c)))) { k--; continue; }
      groups.splice(groups.indexOf(A), 1);
      groups.splice(groups.indexOf(B), 1, {kind: 'adam2', id: B.id, parts: [A, B], refs: [...A.refs, ...B.refs], exposed: [...A.exposed, ...B.exposed]});
      elided.add(A.id);
    }
    const eligible = m => m.op === 'matmul' && !m.bQuant && m.batch === 1 && nodes[m.a].shape.length === 2 && nodes[m.b].shape.length === 2;
    const isT = id => nodes[id].op === 'transpose';
    const memo = new Map();
    // A transpose no one needs as a tensor: every consumer is a 2-D matmul
    // reading it directly, or such a transpose.
    const foldable = id => {
      if (memo.has(id)) return memo.get(id);
      memo.set(id, false);
      const ok = isT(id) && !outputs.has(id) && consumers[id].length > 0 && consumers[id].every(([c, r]) => r === id &&
        ((eligible(nodes[c]) && (nodes[c].a === id || nodes[c].b === id)) || foldable(c)));
      memo.set(id, ok);
      return ok;
    };
    const through = ref => { let id = ref, flip = false; while (isT(id) && foldable(id)) { id = nodes[id].a; flip = !flip; } return {id, flip}; };
    for (const n of nodes) {
      if (!live[n.id] || !eligible(n)) continue;
      const a = through(n.a), b = through(n.b), [only] = consumers[n.id];
      // The result written transposed where a transpose (itself needed as a
      // tensor) is its one reader and K is not split.
      const outT = consumers[n.id].length === 1 && only[1] === n.id && isT(only[0]) && !foldable(only[0]) &&
        !outputs.has(n.id) && !this.splitParts(n) ? only[0] : null;
      // Unchanged unless an operand is read through (an even number of) transposes or the result is.
      if (a.id === n.a && b.id === n.b && outT === null) continue;
      groups.push({kind: 'matmul', id: outT ?? n.id, node: n, transA: a.flip, transB: n.transposed !== b.flip, transOut: outT !== null,
        refs: [a.id, b.id], exposed: [outT ?? n.id]});
      if (outT !== null) elided.add(n.id);
    }
    for (const id of memo.keys()) if (memo.get(id)) elided.add(id);
    this.crossEntropy(plan, live, consumers, outputs, groups, elided);
    this.chains(plan, live, consumers, outputs, groups, elided);
    return {groups, elided};
  }
  /**
   * Chains of elementwise nodes (unary, same-shape or scalar binary, and the
   * K=1 matmul a bias is broadcast with) of one size, each after the first
   * reading an earlier one, computed by one kernel (`chainKernel`) where the
   * last of them stands. A member another node reads is written out too, and
   * only when every such node comes after the chain.
   */
  chains(plan, live, consumers, outputs, groups, elided) {
    const nodes = plan.nodes, root = plan.root, taken = new Set(groups.map(g => g.id));
    const buffers = this.device.limits?.maxStorageBuffersPerShaderStage ?? 8;
    const kind = id => {
      const n = nodes[id];
      if (!live[id] || n.alias || taken.has(id) || elided.has(id)) return null;
      if (UNARY[n.op] !== undefined) return 'unary';
      if (BINARY[n.op] !== undefined && n.mode !== 'general') return 'binary';
      if (n.op === 'matmul' && !n.bQuant && n.batch === 1 && n.k === 1 && nodes[n.a].shape.length === 2 && nodes[n.b].shape.length === 2) return 'k1';
      return null;
    };
    for (const n of nodes) {
      if (!kind(n.id) || taken.has(n.id)) continue;
      const members = [n.id];
      for (let tail = n.id; ;) {
        const next = consumers[tail].map(([c]) => c).filter(c => c > tail && kind(c) && !taken.has(c) && !members.includes(c) &&
          nodes[c].size === n.size).sort((x, y) => x - y)[0];
        // A K=1 matmul only starts a chain: its operands are inputs, not members.
        if (next === undefined || kind(next) === 'k1') break;
        members.push(next); tail = next;
      }
      // Every reader of a member outside the chain must come after it, and
      // the kernel's inputs and outputs must fit the storage buffers one
      // shader may bind.
      let set, anchor, inputs, exposed, spec;
      for (; members.length >= 2; members.pop()) {
        set = new Set(members); anchor = members[members.length - 1];
        if (!members.slice(0, -1).every(id => consumers[id].every(([c]) => set.has(c) || c > anchor))) continue;
        inputs = []; exposed = [];
        const input = r => { let k = inputs.indexOf(r); if (k < 0) { k = inputs.length; inputs.push(r); } return k; };
        spec = members.map(id => {
          const m = nodes[id], k = kind(id);
          const writes = id === anchor || outputs.has(id) || consumers[id].some(([c]) => !set.has(c));
          const args = m.refs.map((r, a) => set.has(root[r]) ? {member: members.indexOf(root[r])}
            : {input: input(r), scalar: k === 'binary' && ((a === 0 && m.mode === 'aScalar') || (a === 1 && m.mode === 'bScalar'))});
          if (writes) exposed.push(id);
          return {kind: k, op: k === 'unary' ? UNARY[m.op] : k === 'binary' ? BINARY[m.op] : 0, args, out: writes ? exposed.length - 1 : -1};
        });
        if (inputs.length + exposed.length <= buffers) break;
      }
      if (members.length < 2) continue;
      const sig = JSON.stringify(spec.map(m => [m.kind, m.op, m.args.map(a => a.member ?? `${a.scalar ? 's' : 'e'}${a.input}`), m.out]));
      const k1 = members.map(id => nodes[id]).find(m => m.op === 'matmul');
      // A 2-D matmul only this chain reads, element for element, which runs
      // on the 16x16 deep-slice kernel whole: computed in the chain's kernel.
      let mm = null;
      for (let k = 0; k < inputs.length && !mm && this.deep !== false && inputs.length + exposed.length + 1 <= buffers; k++) {
        const id = root[inputs[k]], node = nodes[id];
        if (outputs.has(id) || !consumers[id].every(([c]) => set.has(c)) || spec.some(m => m.args.some(a => a.input === k && a.scalar))) continue;
        const g = groups.find(x => x.kind === 'matmul' && x.id === id);
        const src = g ? (g.transOut ? null : {node: g.node, transA: g.transA, transB: g.transB, refs: g.refs, group: g})
          : node.op === 'matmul' && !taken.has(id) && !elided.has(id) && !kind(id) ? {node, transA: false, transB: !!node.transposed, refs: node.refs} : null;
        const m = src?.node;
        if (!m || m.bQuant || m.batch !== 1 || m.size !== n.size || nodes[m.a].shape.length !== 2 || nodes[m.b].shape.length !== 2 ||
          (k1 && k1.n !== m.n)) continue;
        const split = this.splitParts(m);
        if (this.tileFor(m.m, m.n, split ? split.parts : 1) !== 1) continue;
        mm = {...src, input: k, split};
      }
      const name = !mm ? `chain:${sig}` : mm.split ? `reducechain:${mm.input}:${sig}`
        : `mmchain:${matmulName(mm.transB, mm.transA, false, false)}:${mm.input}:${sig}`;
      if (!KERNELS[name]) KERNELS[name] = !mm ? chainKernel(spec, inputs, exposed) : mm.split ? reduceChainKernel(spec, inputs, exposed, mm.input)
        : matmulChainKernel(spec, inputs, exposed, mm);
      const refs = mm ? [...mm.refs, ...inputs.filter((_, k) => k !== mm.input)] : inputs;
      groups.push({kind: 'chain', id: anchor, kernel: name, size: n.size, cols: k1 ? k1.n : 0, refs, exposed,
        mm: mm && {node: mm.node, transA: mm.transA, transB: mm.transB, split: mm.split}});
      if (mm) {
        const id = root[inputs[mm.input]];
        if (mm.group) groups.splice(groups.indexOf(mm.group), 1);
        taken.add(id); elided.add(id);
      }
      for (const id of members) { taken.add(id); if (id !== anchor) elided.add(id); }
    }
  }
  /**
   * A cross_entropy and its gradient over the same logits and targets, of at
   * most 256 rows, as one `ce_both` dispatch -- with the gradient's product
   * by a scalar when that is its only reader. Every reader of a member
   * outside the group must come after it.
   */
  crossEntropy(plan, live, consumers, outputs, groups, elided) {
    const nodes = plan.nodes, root = plan.root, taken = new Set(groups.map(g => g.id));
    const free = n => live[n.id] && !n.alias && !taken.has(n.id) && !elided.has(n.id);
    for (const G of nodes) {
      if (G.op !== 'cross_entropy_grad' || !free(G) || G.rows > 256) continue;
      const L = nodes.find(n => n.op === 'cross_entropy' && free(n) && root[n.refs[0]] === root[G.refs[0]] && root[n.refs[1]] === root[G.refs[1]]);
      if (!L) continue;
      let S = null;
      const readers = consumers[G.id];
      if (!outputs.has(G.id) && readers.length === 1) {
        const M = nodes[readers[0][0]];
        const side = M.mode === 'aScalar' ? 1 : M.mode === 'bScalar' ? 0 : -1;
        if (M.op === 'mul' && side >= 0 && free(M) && root[M.refs[side]] === G.id && M.size === G.size) S = M;
      }
      const members = S ? [L, G, S] : [L, G], ids = new Set(members.map(n => n.id));
      const anchor = Math.max(...ids);
      if (!members.every(n => n.id === anchor || consumers[n.id].every(([c]) => ids.has(c) || c > anchor))) continue;
      const refs = [L.refs[0], L.refs[1], ...(S ? [S.refs[S.mode === 'aScalar' ? 0 : 1]] : [])];
      groups.push({kind: 'ce', id: anchor, rows: L.rows, cols: L.cols, gradSize: G.size, scalar: S ? (S.mode === 'aScalar' ? 1 : 2) : 0,
        refs, exposed: [L.id, S ? S.id : G.id]});
      for (const n of members) { taken.add(n.id); if (n.id !== anchor) elided.add(n.id); }
    }
  }
  /** Runs one fusion group; returns the handles of its `exposed` nodes. */
  async runGroup(item, hs, {stepped, inPlace = null}) {
    if (item.kind === 'adam2') {
      const [A, B] = item.parts, n = A.refs.length, [ipA, ipB] = inPlace ?? [null, null];
      // Each group's refs: m's (mIn, g), v's (vIn, g), then p.
      if (ipA && ipB && this.vectorize) return this.adamPair(A, B, hs[1], hs[n + 1], ipA, ipB, stepped);
      const a = await this.runGroup(A, hs.slice(0, n), {stepped, inPlace: ipA});
      return [...a, ...await this.runGroup(B, hs.slice(n), {stepped, inPlace: ipB})];
    }
    if (item.kind === 'adam') {
      return this.adam(stepped(item.M), stepped(item.V), stepped(item.U), [hs[0], hs[1]], [hs[2], hs[3]], [hs[4]], inPlace);
    }
    if (item.kind === 'ce') {
      const outs = [this.alloc(1), this.alloc(item.gradSize)];
      try {
        await this.dispatch(item.scalar ? 'ce_both_s' : 'ce_both', (u, f) => {
          u[0] = item.rows; u[1] = item.scalar; u[2] = 0; u[3] = item.cols; f[20] = item.rows;
        }, hs, outs, 1, [1, 1, 1]);
      } catch (error) { for (const h of outs) this.free(h); throw error; }
      return outs;
    }
    if (item.kind === 'chain') {
      const outs = item.exposed.map(() => this.alloc(item.size)), mm = item.mm, m = mm?.node;
      try {
        if (mm?.split) {
          // The product's slices as `matmul` computes them, then their sum and the chain.
          const {parts, chunk} = mm.split, partials = this.alloc(m.size * parts);
          try {
            await this.dispatch(`${matmulName(mm.transB, mm.transA, false, true)}_d`, u => {
              u.set([m.m, m.k, m.n, m.batch], 16); u[8] = m.aBatchStride; u[9] = m.bBatchStride; u[10] = chunk;
            }, hs.slice(0, 2), partials, m.size * parts, [Math.ceil(m.n / 16), Math.ceil(m.m / 16), parts]);
            await this.dispatch(item.kernel, u => {u[0] = m.size; u[1] = 0; u[2] = 0; u[3] = parts; u[16] = m.size; u[17] = m.n;},
              [partials, ...hs.slice(2)], outs, m.size);
          } finally { this.free(partials); }
        } else if (mm) {
          await this.dispatch(item.kernel, u => {u.set([m.m, m.k, m.n, m.batch], 16); u[8] = m.aBatchStride; u[9] = m.bBatchStride; u[3] = 0;},
            hs, outs, item.size, [Math.ceil(m.n / 16), Math.ceil(m.m / 16), 1]);
        } else await this.dispatch(item.kernel, u => {u[0] = item.size; u[3] = 0; u[16] = item.cols;}, hs, outs, item.size);
      } catch (error) { for (const h of outs) this.free(h); throw error; }
      return outs;
    }
    const out = this.alloc(item.node.size);
    try {
      await this.matmul(item.node, hs, out, item.transB, item.transA, item.transOut);
    } catch (error) { this.free(out); throw error; }
    return [out];
  }
  /** A session carry: the step's output is copied into the input's fixed buffer, in stream order. */
  carry(src, dst) {
    this.live();
    if (this.pass) { this.pass.end(); this.pass = null; }
    if (!this.encoder) this.encoder = this.device.createCommandEncoder();
    this.encoder.copyBufferToBuffer(src.buffer, 0, dst.buffer, 0, src.size * 4);
  }
  async pairwise(input, out) {
    const scratch = [];
    try {
      if (input.size === 1) { await this.dispatch('scale', (u, f) => {u[0] = 1; f[20] = 1;}, [input], out, 1); return; }
      while (input.size > 1) {
        const length = Math.ceil(input.size / 2), next = length === 1 ? out : this.alloc(length), len = input.size;
        if (next !== out) scratch.push(next);
        await this.dispatch('pair', u => {u[0] = length; u[3] = len;}, [input], next, length);
        input = next;
      }
    } finally {for (const h of scratch) this.free(h);}
  }
  async run(n, refs) {
    // A quantized input's buffer is its blocks: size counts four-byte words,
    // so binding, pooling and accounting are unchanged, and nothing expands it.
    if (n.op === 'input') {
      return n.quant ? this.alloc(words(n.data).length, words(n.data)) : this.alloc(n.size, n.data);
    }
    const out = this.alloc(n.size), [a] = refs;
    // Debug mode attributes validation errors to the node that caused them.
    let scoped = this.debug;
    if (scoped) this.device.pushErrorScope('validation');
    try {
      switch (n.op) {
        case 'full': await this.dispatch(this.vectorize ? 'fill4' : 'fill', (u, f) => {u[0] = n.size; f[20] = n.value;}, [], out, n.size); break;
        case 'add': case 'sub': case 'mul': case 'div': case 'maximum': case 'minimum':
        case 'eq': case 'ne': case 'lt': case 'le': case 'gt': case 'ge':
          await this.dispatch(this.vectorize && n.mode !== 'general' ? 'binary4' : 'binary', u => {u[0] = n.size; u[1] = MODE[n.mode]; u[2] = BINARY[n.op];
            if (n.mode === 'general') {u.set(n.dims, 4); u.set(n.aStrides, 8); u.set(n.bStrides, 12);}}, refs, out, n.size); break;
        case 'relu': case 'positive': case 'neg': case 'exp': case 'log': case 'sqrt':
        case 'tanh': case 'sigmoid': case 'gelu': case 'gelu_grad':
          await this.dispatch(this.vectorize ? 'unary4' : 'unary', u => {u[0] = n.size; u[2] = UNARY[n.op];}, refs, out, n.size); break;
        case 'where':
          await this.dispatch('where', u => {u[0] = n.size; u[1] = n.mode === 'same' ? 0 : 3;
            u.set(n.dims, 4); u.set(n.cStrides, 8); u.set(n.aStrides, 12); u.set(n.bStrides, 16);}, refs, out, n.size); break;
        case 'uniform':
          await this.dispatch('uniform', u => {u[0] = n.size; u[16] = n.seed >>> 0; u[17] = n.step >>> 0;}, [], out, n.size); break;
        case 'transpose': case 'permute':
          await this.dispatch('gather', u => {u[0] = n.size; u.set(n.dims, 4); u.set(n.srcStrides, 8);}, refs, out, n.size); break;
        // Signed strides and begins are stored as their 32-bit two's complement.
        case 'slice':
          await this.dispatch('slice', u => {u[0] = n.size; u.set(n.boxDims, 4); u.set(n.boxStrides.map(v => v >>> 0), 8); u[16] = n.offset;}, refs, out, n.size); break;
        case 'slice_scatter':
          await this.dispatch('slice_scatter', u => {u[0] = n.size; u.set(n.dims, 4); u.set(n.begin4, 8); u.set(n.stride4.map(v => v >>> 0), 12); u.set(n.boxDims, 16);},
            refs, out, n.size); break;
        case 'index_select': case 'index_add': {
          // index_add: a workgroup per output row, [outer * N] of them.
          const rows = n.size / n.inner, limit = this.device.limits.maxComputeWorkgroupsPerDimension;
          await this.dispatch(n.op, u => {u[0] = n.size; u[3] = n.count; u[16] = n.len; u[17] = n.inner;}, refs, out, n.size,
            n.op === 'index_add' ? [Math.min(rows, limit), Math.ceil(rows / limit), 1] : null); break;
        }
        case 'gather':
          await this.dispatch('gather_axis', u => {u[0] = n.size; u.set(n.dims, 4); u.set(n.srcStrides, 8); u[16] = n.axisStride; u[17] = n.len;}, refs, out, n.size); break;
        case 'scatter_add':
          await this.dispatch('scatter_add', u => {u[0] = n.size; u.set(n.dims, 4); u.set(n.indexDims, 8); u[16] = n.axis4;}, refs, out, n.size); break;
        case 'sum': case 'mean':
          if (n.whole && this.fuse !== false && n.inputSize <= 2048) {
            await this.dispatch('sum_small', (u, f) => {u[0] = n.inputSize; u[1] = +(n.op === 'mean'); f[20] = n.inputSize;}, refs, out, 1, [1, 1, 1]);
            break;
          }
          if (n.whole) {
            if (n.op === 'sum') { await this.pairwise(a, out); break; }
            const total = this.alloc(1);
            try {
              await this.pairwise(a, total);
              await this.dispatch('scale', (u, f) => {u[0] = 1; f[20] = n.inputSize;}, [total], out, 1);
            } finally {this.free(total);}
          } else await this.dispatch('reduce', u => {u[0] = n.outer * n.inner; u[1] = +(n.op === 'mean'); u[3] = n.len; u[16] = n.inner;}, refs, out, n.outer * n.inner);
          break;
        case 'softmax': case 'log_softmax':
          await this.dispatch('softmax', u => {u[0] = n.rows; u[1] = +(n.op === 'log_softmax'); u[3] = n.cols;}, refs, out, n.rows); break;
        case 'cross_entropy': {
          if (this.fuse !== false && n.rows <= 1024) {
            await this.dispatch('ce_small', (u, f) => {u[0] = n.rows; u[3] = n.cols; f[20] = n.rows;}, refs, out, 1, [1, 1, 1]);
            break;
          }
          const rows = this.alloc(n.rows), total = this.alloc(1);
          try {
            await this.dispatch('ce_rows', u => {u[0] = n.rows; u[3] = n.cols;}, refs, rows, n.rows);
            await this.pairwise(rows, total);
            await this.dispatch('scale', (u, f) => {u[0] = 1; f[20] = n.rows;}, [total], out, 1);
          } finally {this.free(rows); this.free(total);}
          break;
        }
        case 'cross_entropy_grad': await this.dispatch('ce_grad', u => {u[0] = n.rows; u[3] = n.cols;}, refs, out, n.rows); break;
        // Not yet on this backend, and refused rather than skipped. An
        // operation with no case here would leave its output buffer at zero and
        // return a plausible tensor of nothing, which for a result that is
        // meant to be *checkable* is the worst available failure. Integer
        // accumulation needs 64 bits -- products reach 2^30 and their sums 2^40
        // -- and neither WGSL nor GLSL ES has a 64-bit integer, so this waits
        // on paired-u32 arithmetic. See docs/FIXED-POINT.md.
        // A throw and not a `check(false, ...)`, so that no reading of this
        // can end in a fall-through to the float32 `matmul` below.
        case 'matmul_fixed': throw new ComputeError('UNSUPPORTED',
          'matmul_fixed needs a 64-bit integer accumulator, which WebGPU has no native type for; run it on the wasm or cpu-js backend');
        case 'matmul': await this.matmul(n, refs, out, n.transposed, false, false); break;
        case 'sgd_update': case 'momentum_update': case 'adam_m': case 'adam_v': case 'adam_update': {
          const scalars = {sgd_update: [n.lr], momentum_update: [n.momentum, n.w], adam_m: [n.w], adam_v: [n.beta2, n.w],
            adam_update: [n.stepSize, n.bc2Sqrt, n.eps]}[n.op];
          await this.dispatch(this.vectorize ? 'optim4' : 'optim', (u, f) => {u[0] = n.size; u[2] = OPTIM[n.op]; f.set(scalars, 20);},
            [refs[0], refs[1], refs[2] ?? refs[1]], out, n.size); break;
        }
        case 'life': await this.dispatch('life', u => {u[0] = n.size; u[16] = n.shape[0]; u[17] = n.shape[1];}, refs, out, n.size); break;
      }
      if (scoped) {
        scoped = false;
        const error = await this.device.popErrorScope();
        check(!error, 'GPU', `${n.op}: ${error?.message}`);
      }
      return out;
    } catch(error) {
      if (scoped) await this.device.popErrorScope().catch(() => {});
      this.free(out); throw error;
    }
  }
  /** Uploads this execution's uniforms and submits its one command buffer. */
  flush(extra = () => {}) {
    if (this.pass) {this.pass.end(); this.pass = null;}
    if (!this.encoder) this.encoder = this.device.createCommandEncoder();
    extra(this.encoder);
    if (this.slot > 0) this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData, 0, this.slot * SLOT);
    const commands = this.encoder.finish(); this.encoder = null;
    this.device.queue.submit([commands]);
  }
  /** A MAP_READ buffer kept across session runs (grown when a readback outgrows it). */
  stagingFor(total) {
    if (this.staging && this.staging.size >= total) return this.staging;
    if (this.staging) this.staging.destroy();
    this.staging = this.device.createBuffer({size: Math.max(total, 4096), usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    return this.staging;
  }
  /**
   * A session run's end: submit, then await the readback map, both error
   * scopes and the queue in ONE round trip to the GPU process (readAll then
   * finish take two). Leaves nothing for finish to do.
   */
  async complete(handles) {
    this.live();
    const offsets = []; let total = 0;
    for (const h of handles) {offsets.push(total); total += h.size * 4;}
    const staging = total ? this.stagingFor(total) : null;
    this.flush(encoder => handles.forEach((h, i) => encoder.copyBufferToBuffer(h.buffer, 0, staging, offsets[i], h.size * 4)));
    const pops = [this.device.popErrorScope(), this.device.popErrorScope()]; this.scopeOpen = false;
    try {
      const [validation, memory] = await Promise.all([...pops, staging ? staging.mapAsync(GPUMapMode.READ, 0, total) : null]);
      if (validation || memory) throw new ComputeError('GPU', (validation || memory).message);
      this.live();
      if (!staging) return [];
      const all = new Float32Array(staging.getMappedRange(0, total));
      return handles.map((h, i) => all.slice(offsets[i] / 4, offsets[i] / 4 + h.size));
    } catch (error) {
      if (this.staging) { try { this.staging.destroy(); } catch { /* lost */ } this.staging = null; }
      throw error;
    } finally {
      if (this.staging?.mapState === 'mapped') this.staging.unmap();
      this.reclaim();
    }
  }
  /** Every requested output through one staging buffer: one submit, one map. */
  async readAll(handles) {
    this.live();
    const offsets = [];let total = 0;
    for (const h of handles) {offsets.push(total); total += h.size * 4;}
    const staging = this.device.createBuffer({size: total, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    try {
      this.flush(encoder => handles.forEach((h, i) => encoder.copyBufferToBuffer(h.buffer, 0, staging, offsets[i], h.size * 4)));
      await staging.mapAsync(GPUMapMode.READ);
      const all = new Float32Array(staging.getMappedRange());
      return handles.map((h, i) => all.slice(offsets[i] / 4, offsets[i] / 4 + h.size));
    } finally {if (staging.mapState === 'mapped') staging.unmap(); staging.destroy();}
  }
  async read(h) { return (await this.readAll([h]))[0]; }
  // Freed during an execution: recycled until it settles. Freed between
  // executions (a session releasing a resident buffer): idle at once.
  free(h) { if (!h.freed) { h.freed = true; if (this.scopeOpen) this.recycled.push(h); else this.pool(h); } }
  // Idle lists stay sorted by buffer id, so a session run that starts from
  // the same pool allocates the same buffers every time (and its cached bind
  // groups keep matching); alloc takes from the end.
  pool(h) {
    if (this.idleBytes + h.bytes > this.poolBytes) {h.buffer.destroy(); this.liveBufferBytes -= h.bytes; return;}
    if (!this.idle.has(h.bytes)) this.idle.set(h.bytes, []);
    const list = this.idle.get(h.bytes), id = this.idOf(h.buffer);
    let i = list.length; while (i > 0 && this.idOf(list[i - 1]) > id) i--;
    list.splice(i, 0, h.buffer); this.idleBytes += h.bytes;
  }
  reclaim() { for (const h of this.recycled) this.pool(h); this.recycled = []; }
  async finish() {
    if (!this.scopeOpen) { this.reclaim(); return; }
    this.scopeOpen = false;
    // Unsubmitted commands (a failed execution) are dropped with their encoder.
    if (this.pass) {this.pass.end(); this.pass = null;}
    this.encoder = null;
    try {
      // Scopes pop in order; their answers and the queue drain are awaited together.
      const [validation, memory] = await Promise.all([this.device.popErrorScope(), this.device.popErrorScope(),
        this.device.queue.onSubmittedWorkDone()]);
      if (validation || memory) throw new ComputeError('GPU', (validation || memory).message);
      this.live();
    } finally { this.reclaim(); }
  }
  dispose() {
    for (const list of this.idle.values()) for (const b of list) b.destroy();
    for (const h of this.recycled) h.buffer.destroy();
    if (this.uniformBuffer) this.uniformBuffer.destroy();
    if (this.staging) this.staging.destroy();
    this.idle.clear(); this.recycled = []; this.groups.clear(); this.pipelines.clear(); this.uniformBuffer = null; this.staging = null; this.device.destroy();
  }
}
