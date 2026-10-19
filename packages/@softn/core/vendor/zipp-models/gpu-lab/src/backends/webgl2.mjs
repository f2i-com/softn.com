import {check, ComputeError, DEFAULT_LIMITS} from '../graph.mjs';
const UNSUPPORTED=new Set(['matmul_fixed']);

// Shared GLSL: texel addressing, the shared erf-based CDF and an overflow-free
// tanh. Shapes and scalars arrive as uniforms, so one program serves every shape.
const PRELUDE = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D; precision highp usampler2D;
uniform int wO, nO, wA, wB, wC, wD, mode, op, len;
uniform ivec4 d, sa, sb, g;
uniform vec4 f;
out vec4 resultColor;
// A bit-pattern test: HLSL compilers behind ANGLE may fold isnan() or x != x away.
bool isNaN(float x) { return (floatBitsToUint(x) & 0x7fffffffu) > 0x7f800000u; }
int strided(int i, ivec4 s) {
  int x3 = i % d.w; int r3 = i / d.w; int x2 = r3 % d.z; int r2 = r3 / d.z;
  return (r2 / d.y) * s.x + (r2 % d.y) * s.y + x2 * s.z + x3 * s.w;
}
float erfSeries(float z) {
  float t = z * z;
  return z * (1.1283791670955126 + t * (-0.37612638903183754 + t * (0.11283791670955126 + t * (-0.026866170645131252 +
    t * (0.005223977625442188 + t * (-0.0008548327023450852 + t * 0.00012055332981789664))))));
}
float erfcFit(float a) {
  float t = 1.0 / (1.0 + 0.5 * a);
  return t * exp(-a * a - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
    t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
}
float cdf(float x) {
  float z = x * 0.7071067811865476;
  if (abs(z) < 0.5) return 0.5 + 0.5 * erfSeries(z);
  if (z >= 10.0) return 1.0;
  if (z <= -10.0) return 0.0;
  float c = 0.5 * erfcFit(abs(z));
  return z > 0.0 ? 1.0 - c : c;
}
// Binary operations by code: arithmetic, then maximum/minimum (NaN from
// either side, a tie to x) and 0/1 comparisons (NaN compares unequal). NaN is
// tested by bits, never trusted to an ordered comparison the driver may fold.
float binop(int o, float x, float y) {
  if (o == 0) return x + y;
  if (o == 1) return x - y;
  if (o == 2) return x * y;
  if (o == 3) return x / y;
  bool unordered = isNaN(x) || isNaN(y);
  // A tie is decided first: under ANGLE's Direct3D backend -0 < +0 came out
  // true (or the select became max(), whose zero sign is the driver's), and
  // -0 against +0 is exactly the tie that must go to x.
  if (o == 4) return unordered ? x + y : x == y ? x : (x < y ? y : x);
  if (o == 5) return unordered ? x + y : x == y ? x : (y < x ? y : x);
  if (o == 7) return unordered || x != y ? 1.0 : 0.0;
  if (unordered) return 0.0;
  if (o == 6) return x == y ? 1.0 : 0.0;
  if (o == 8) return x < y ? 1.0 : 0.0;
  if (o == 9) return x <= y ? 1.0 : 0.0;
  if (o == 10) return x > y ? 1.0 : 0.0;
  return x >= y ? 1.0 : 0.0;
}
// The uniform generator's hash: lowbias32, in uint arithmetic modulo 2^32.
uint mix32(uint x) {
  x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; return x ^ (x >> 16u);
}
float tanhS(float x) {
  if (isNaN(x)) return x;
  float a = abs(x);
  if (a < 0.25) { float z = x * x; return x * (1.0 + z * (-0.3333333333333333 + z * (0.13333333333333333 + z * (-0.05396825396825397 + z * 0.021869488536155203)))); }
  float t = exp(-2.0 * min(a, 20.0));
  float r = (1.0 - t) / (1.0 + t);
  return x < 0.0 ? -r : r;
}`;
const SAMPLERS = ['A', 'B', 'C', 'D'];
// A samples a float texture; B:u32 samples an R32UI one, which is how a
// quantized weight arrives -- blocks, not values. Only ever read, never a
// render target, so it needs no renderable format.
const io = inputs => inputs.map(entry => {
  const [name, type] = entry.split(':');
  return type === 'u32'
    ? `uniform highp usampler2D t${name};
uint ${name}(int j) { return texelFetch(t${name}, ivec2(j % w${name}, j / w${name}), 0).r; }`
    : `uniform highp sampler2D t${name};
float ${name}(int j) { return texelFetch(t${name}, ivec2(j % w${name}, j / w${name}), 0).r; }`;
}).join('\n');
const each = body => `void main() {
  int i = int(gl_FragCoord.y) * wO + int(gl_FragCoord.x);
  if (i >= nO) { resultColor = vec4(0.0); return; }
  float value = 0.0;
  ${body}
  resultColor = vec4(value, 0.0, 0.0, 0.0);
}`;
// Q4_K: 256 values per 144-byte block -- an f16 scale and minimum, eight 6-bit
// sub-block scales and minimums packed into 12 bytes, then 256 nibbles. A port
// of dequantize_row_q4_K; src/quant.mjs is the same thing in JavaScript and
// the gguf-quants crate is it in Rust.
const QUANT_GLSL = `uint qbyte(int off) { return (B(off >> 2) >> uint((off & 3) * 8)) & 0xffu; }
uint qhalfBits(int off) { return qbyte(off) | (qbyte(off + 1) << 8); }
int qbase(int block0, int col, int K, int e, int bytes) {
  return (block0 + col * (K / 256) + e / 256) * bytes;
}
vec2 q4kScaleMin(int base, int j) {
  if (j < 4) return vec2(float(qbyte(base + 4 + j) & 63u), float(qbyte(base + 8 + j) & 63u));
  uint hi = qbyte(base + j + 8);
  uint lo = qbyte(base + j);
  uint me = qbyte(base + j + 4);
  return vec2(float((hi & 15u) | ((lo >> 6) << 4)), float((hi >> 4) | ((me >> 6) << 4)));
}
float q4k(int block0, int col, int K, int e) {
  int base = qbase(block0, col, K, e, 144);
  int within = e % 256; int pair = within / 64; int rem = within % 64;
  uint byte = qbyte(base + 16 + pair * 32 + rem % 32);
  uint nibble = rem < 32 ? (byte & 15u) : (byte >> 4);
  int j = pair * 2 + (rem < 32 ? 0 : 1);
  vec2 sm = q4kScaleMin(base, j);
  float d = unpackHalf2x16(qhalfBits(base)).x;
  float dmin = unpackHalf2x16(qhalfBits(base + 2)).x;
  return (d * sm.x) * float(nibble) - dmin * sm.y;
}
float q6k(int block0, int col, int K, int e) {
  int base = qbase(block0, col, K, e, 210);
  // half is a reserved word in GLSL ES, so the two 128-value halves are hf.
  int within = e % 256; int hf = within / 128; int rem = within % 128;
  int sub = rem / 32; int l = rem % 32;
  uint ql = qbyte(base + 64 * hf + l + 32 * (sub & 1));
  uint low = sub < 2 ? (ql & 15u) : (ql >> 4);
  uint high = (qbyte(base + 128 + 32 * hf + l) >> uint(2 * sub)) & 3u;
  float scale = float(int(qbyte(base + 192 + 8 * hf + l / 16 + 2 * sub) << 24) >> 24);
  float d = unpackHalf2x16(qhalfBits(base + 208)).x;
  return (d * scale) * float(int(low | (high << 4)) - 32);
}

// One dot product against a quantized row, reading each block's constants once.
//
// A fragment walks the reduced axis in order, so 256 consecutive weights share
// a block and 32 or 16 share a sub-block scale. Reading those per weight cost
// about eight texture fetches each and made a quantized product two and a half
// times a float32 one; reading them when they change costs closer to one.
//
// The arithmetic is untouched: the scale is still folded into d before it
// meets a quant, in that order, so this still equals the same product over
// decoded values exactly.
float q4kDot(int ab, int block0, int col, int K, int k0, int k1) {
  int per = K / 256;
  int heldBlock = -1; int heldSub = -1; int base = 0;
  float d = 0.0; float dmin = 0.0; float scale = 0.0; float minimum = 0.0;
  float total = 0.0;
  for (int k = k0; k < k1; k++) {
    int index = block0 + col * per + k / 256;
    if (index != heldBlock) {
      base = index * 144; heldBlock = index; heldSub = -1;
      d = unpackHalf2x16(qhalfBits(base)).x;
      dmin = unpackHalf2x16(qhalfBits(base + 2)).x;
    }
    int within = k % 256; int pair = within / 64; int rem = within % 64;
    int j = pair * 2 + (rem < 32 ? 0 : 1);
    if (j != heldSub) {
      heldSub = j;
      vec2 sm = q4kScaleMin(base, j);
      scale = d * sm.x; minimum = dmin * sm.y;
    }
    uint byte = qbyte(base + 16 + pair * 32 + rem % 32);
    uint nibble = rem < 32 ? (byte & 15u) : (byte >> 4);
    total += A(ab + k) * (scale * float(nibble) - minimum);
  }
  return total;
}
float q6kDot(int ab, int block0, int col, int K, int k0, int k1) {
  int per = K / 256;
  int heldBlock = -1; int heldScale = -1; int base = 0;
  float d = 0.0; float scale = 0.0;
  float total = 0.0;
  for (int k = k0; k < k1; k++) {
    int index = block0 + col * per + k / 256;
    if (index != heldBlock) {
      base = index * 210; heldBlock = index; heldScale = -1;
      d = unpackHalf2x16(qhalfBits(base + 208)).x;
    }
    int within = k % 256; int hf = within / 128; int rem = within % 128;
    int sub = rem / 32; int l = rem % 32;
    int at = 192 + 8 * hf + l / 16 + 2 * sub;
    if (at != heldScale) {
      heldScale = at;
      scale = d * float(int(qbyte(base + at) << 24) >> 24);
    }
    uint ql = qbyte(base + 64 * hf + l + 32 * (sub & 1));
    uint low = sub < 2 ? (ql & 15u) : (ql >> 4);
    uint high = (qbyte(base + 128 + 32 * hf + l) >> uint(2 * sub)) & 3u;
    total += A(ab + k) * (scale * float(int(low | (high << 4)) - 32));
  }
  return total;
}
`;
const KERNELS = {
  fill: [[], each('value = f.x;')],
  unary: [['A'], each(`float x = A(i);
  switch (op) {
    case 0: value = (x > 0.0 || isNaN(x)) ? x : 0.0; break;
    case 1: value = x > 0.0 ? 1.0 : 0.0; break;
    case 2: value = -x; break;
    case 3: value = exp(x); break;
    case 4: value = log(x); break;
    case 5: value = sqrt(x); break;
    case 6: value = tanhS(x); break;
    case 7: { float e = exp(-abs(x)); value = x >= 0.0 ? 1.0 / (1.0 + e) : e / (1.0 + e); break; }
    case 8: value = x * cdf(x); break;
    default: value = cdf(x) + x * 0.3989422804014327 * exp(-0.5 * min(x * x, 200.0)); break;
  }`)],
  binary: [['A', 'B'], each(`int ia = i; int ib = i;
  if (mode == 1) ia = 0; else if (mode == 2) ib = 0; else if (mode == 3) { ia = strided(i, sa); ib = strided(i, sb); }
  value = binop(op, A(ia), B(ib));`)],
  // where(c, a, b) (A = condition, B = a, C = b): nonzero bits (NaN included) pick B.
  // g carries b's strides, the fourth uniform vector the prelude declares.
  where: [['A', 'B', 'C'], each(`int ic = i; int ia = i; int ib = i;
  if (mode == 3) { ic = strided(i, sa); ia = strided(i, sb); ib = strided(i, g); }
  value = (floatBitsToUint(A(ic)) & 0x7fffffffu) != 0u ? B(ia) : C(ib);`)],
  // Seed and step arrive as 16-bit halves (d), so no uniform int is ever
  // asked to hold a value past 2^31.
  uniform: [[], each(`uint k1 = mix32((uint(d.x) | (uint(d.y) << 16u)) ^ 0x9e3779b9u);
  uint k2 = mix32((uint(d.z) | (uint(d.w) << 16u)) ^ k1);
  value = float(mix32(mix32(uint(i) ^ k2) + k1) >> 8u) * 5.9604644775390625e-8;`)],
  gather: [['A'], each('value = A(strided(i, sa));')],
  // Version 4. slice: the strided gather from the box's first element (g.x);
  // its strides (sa) may be negative, which int arithmetic carries as is.
  slice: [['A'], each('value = A(g.x + strided(i, sa));')],
  // slice_scatter over the base's padded dims (d): an element inside the box
  // (begin sa, signed stride sb, extent g) takes the source's value, the rest
  // the base's. Distances are made non-negative before any division.
  slice_scatter: [['A', 'B'], each(`int x3 = i % d.w; int r3 = i / d.w; int x2 = r3 % d.z; int r2 = r3 / d.z;
  ivec4 x = ivec4(r2 / d.y, r2 % d.y, x2, x3);
  ivec4 q = ivec4(0); bool inside = true;
  for (int k = 0; k < 4; k++) {
    int s = abs(sb[k]); int t = sb[k] > 0 ? x[k] - sa[k] : sa[k] - x[k];
    if (t < 0 || t % s != 0 || t / s >= g[k]) { inside = false; break; }
    q[k] = t / s;
  }
  value = inside ? B(((q.x * g.y + q.y) * g.z + q.z) * g.w + q.w) : A(i);`)],
  // index_select over [outer, N = g.x, inner = g.y], len the index's length (B).
  index_select: [['A', 'B'], each(`int inner = g.y; int r = i % inner; int k = (i / inner) % len; int o = i / (inner * len);
  int p = clamp(int(B(k)), 0, g.x - 1);
  value = A((o * g.x + p) * inner + r);`)],
  // index_add: the base (A) plus every source row (B, [outer, len, inner]) whose
  // index (C) names this position, in ascending k.
  index_add: [['A', 'B', 'C'], each(`int inner = g.y; int r = i % inner; int p = (i / inner) % g.x; int o = i / (inner * g.x);
  value = A(i);
  for (int k = 0; k < len; k++) if (int(C(k)) == p) value += B((o * len + k) * inner + r);`)],
  // gather over the index's padded dims (d): a's strides with the axis zeroed
  // (sa), plus the index value (B, clamped below g.y) times the axis stride g.x.
  gather_axis: [['A', 'B'], each('value = A(strided(i, sa) + clamp(int(B(i)), 0, g.y - 1) * g.x);')],
  // scatter_add over the base's padded dims (d): the index's padded dims (sa),
  // the padded axis (g.x); every index element along the axis that lies at this
  // position off the axis and names it, in ascending order, adds its source.
  scatter_add: [['A', 'B', 'C'], each(`int x3 = i % d.w; int r3 = i / d.w; int x2 = r3 % d.z; int r2 = r3 / d.z;
  ivec4 x = ivec4(r2 / d.y, r2 % d.y, x2, x3);
  value = A(i);
  bool within = true;
  for (int k = 0; k < 4; k++) if (k != g.x && x[k] >= sa[k]) within = false;
  if (within) {
    int want = x[g.x]; ivec4 q = x;
    for (int k = 0; k < sa[g.x]; k++) {
      q[g.x] = k;
      int j = ((q.x * sa.y + q.y) * sa.z + q.z) * sa.w + q.w;
      if (int(C(j)) == want) value += B(j);
    }
  }`)],
  pair: [['A'], each('int j = i * 2; value = A(j); if (j + 1 < len) value += A(j + 1);')],
  scale: [['A'], each('value = A(i) / f.x;')],
  reduce: [['A'], each(`int inner = g.x; int base = (i / inner) * len * inner + i % inner;
  for (int j = 0; j < len; j++) value += A(base + j * inner);
  if (mode == 1) value = value / float(len);`)],
  // Softmax-family rows in passes: the maximum per row, the float32 sum of
  // exp(x - max) per row (B = maxima), then one output per element.
  row_max: [['A'], each(`int base = i * len; value = A(base);
  for (int j = 1; j < len; j++) { float v = A(base + j); value = (v > value || isNaN(v)) ? v : value; }`)],
  row_sum: [['A', 'B'], each(`int base = i * len; float m = B(i);
  for (int j = 0; j < len; j++) value += exp(A(base + j) - m);`)],
  softmax: [['A', 'B', 'C'], each(`int row = i / len; float x = A(i) - B(row);
  value = mode == 1 ? x - log(C(row)) : exp(x) / C(row);`)],
  // Cross-entropy from the same row statistics (B = maxima, C = sums, D = class targets).
  ce_rows: [['A', 'B', 'C', 'D'], each(`int t = clamp(int(max(D(i), 0.0)), 0, len - 1);
  value = log(C(i)) - (A(i * len + t) - B(i));`)],
  ce_grad: [['A', 'B', 'C', 'D'], each(`int row = i / len; int t = clamp(int(max(D(row), 0.0)), 0, len - 1);
  value = (exp(A(i) - B(row)) / C(row) - (i - row * len == t ? 1.0 : 0.0)) / float(g.x);`)],
  matmul: [['A', 'B'], each(`int M = g.x; int K = g.y; int N = g.z;
  int batch = i / (M * N); int rc = i - batch * M * N; int row = rc / N; int col = rc - row * N;
  int ab = batch * sa.x + row * K; int bb = batch * sa.y + col;
  for (int k = 0; k < K; k++) value += A(ab + k) * B(bb + k * N);`)],
  // The same product over a weight stored [N, K]: one contiguous row per output
  // column, which is how a checkpoint writes a linear layer.
  matmul_t: [['A', 'B'], each(`int M = g.x; int K = g.y; int N = g.z;
  int batch = i / (M * N); int rc = i - batch * M * N; int row = rc / N; int col = rc - row * N;
  int ab = batch * sa.x + row * K; int bb = batch * sa.y + col * K;
  for (int k = 0; k < K; k++) value += A(ab + k) * B(bb + k);`)],
  // And over a weight that is still Q4_K blocks, decoded a value at a time as
  // the loop reaches it. The texture holds 144 bytes per 256 weights and never
  // the 1024 they expand to.
  matmul_q4k: [['A', 'B:u32'], QUANT_GLSL + each(`int M = g.x; int K = g.y; int N = g.z;
  int batch = i / (M * N); int rc = i - batch * M * N; int row = rc / N; int col = rc - row * N;
  value = q4kDot(batch * sa.x + row * K, (batch * sa.y) / 256, col, K, 0, K);`)],
  matmul_q6k: [['A', 'B:u32'], QUANT_GLSL + each(`int M = g.x; int K = g.y; int N = g.z;
  int batch = i / (M * N); int rc = i - batch * M * N; int row = rc / N; int col = rc - row * N;
  value = q6kDot(batch * sa.x + row * K, (batch * sa.y) / 256, col, K, 0, K);`)],
  // Split along the reduced axis, then sum the parts.
  //
  // A fragment shader runs one invocation per output element, and a decode step
  // multiplies [1, 1024] by [2048, 1024]: two thousand invocations, each walking
  // a thousand dependent texture reads. That leaves a GPU almost idle -- the
  // model's own matmuls measured slower than one matmul with a hundred times
  // more outputs. Splitting the reduced axis into parts gives the same product
  // as many times more invocations, and `reduce` adds the parts back.
  //
  // Both operands are read exactly as the unsplit kernels read them, and within
  // a part the order is unchanged, so a quantized product still equals the same
  // product over decoded values on this backend.
  matmul_split: [['A', 'B'], each(`int M = g.x; int K = g.y; int N = g.z; int chunk = sa.w;
  int perPart = nO / max(sa.z, 1); int part = i / perPart; int rest = i - part * perPart;
  int batch = rest / (M * N); int rc = rest - batch * M * N; int row = rc / N; int col = rc - row * N;
  int k0 = part * chunk; int k1 = min(K, k0 + chunk);
  int ab = batch * sa.x + row * K;
  int bb = batch * sa.y + col;
  for (int k = k0; k < k1; k++) value += A(ab + k) * B(bb + k * N);`)],
  matmul_t_split: [['A', 'B'], each(`int M = g.x; int K = g.y; int N = g.z; int chunk = sa.w;
  int perPart = nO / max(sa.z, 1); int part = i / perPart; int rest = i - part * perPart;
  int batch = rest / (M * N); int rc = rest - batch * M * N; int row = rc / N; int col = rc - row * N;
  int k0 = part * chunk; int k1 = min(K, k0 + chunk);
  int ab = batch * sa.x + row * K;
  int bb = batch * sa.y + col * K;
  for (int k = k0; k < k1; k++) value += A(ab + k) * B(bb + k);`)],
  matmul_q4k_split: [['A', 'B:u32'], QUANT_GLSL + each(`int M = g.x; int K = g.y; int N = g.z; int chunk = sa.w;
  int perPart = nO / max(sa.z, 1); int part = i / perPart; int rest = i - part * perPart;
  int batch = rest / (M * N); int rc = rest - batch * M * N; int row = rc / N; int col = rc - row * N;
  int k0 = part * chunk; int k1 = min(K, k0 + chunk);
  int ab = batch * sa.x + row * K;
  value = q4kDot(ab, (batch * sa.y) / 256, col, K, k0, k1);`)],
  matmul_q6k_split: [['A', 'B:u32'], QUANT_GLSL + each(`int M = g.x; int K = g.y; int N = g.z; int chunk = sa.w;
  int perPart = nO / max(sa.z, 1); int part = i / perPart; int rest = i - part * perPart;
  int batch = rest / (M * N); int rc = rest - batch * M * N; int row = rc / N; int col = rc - row * N;
  int k0 = part * chunk; int k1 = min(K, k0 + chunk);
  int ab = batch * sa.x + row * K;
  value = q6kDot(ab, (batch * sa.y) / 256, col, K, k0, k1);`)],
  optim: [['A', 'B', 'C'], each(`float a = A(i); float b = B(i);
  if (op == 0) value = a - f.x * b;
  else if (op == 1) value = f.x * a + f.y * b;
  else if (op == 2) value = f.x < 0.5 ? a + f.x * (b - a) : b - (b - a) * (1.0 - f.x);
  else if (op == 3) value = a * f.x + f.y * b * b;
  else value = a - f.x * (b / (sqrt(C(i)) / f.y + f.z));`)],
  life: [['A'], each(`int h = g.x; int w = g.y; int x = i % w; int y = i / w; int count = 0;
  for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) if (dx != 0 || dy != 0) {
    int xx = (x + dx + w) % w; int yy = (y + dy + h) % h; count += A(yy * w + xx) > 0.5 ? 1 : 0; }
  value = count == 3 || (A(i) > 0.5 && count == 2) ? 1.0 : 0.0;`)],
};
const UNARY = {relu: 0, positive: 1, neg: 2, exp: 3, log: 4, sqrt: 5, tanh: 6, sigmoid: 7, gelu: 8, gelu_grad: 9};
const BINARY = {add: 0, sub: 1, mul: 2, div: 3, maximum: 4, minimum: 5, eq: 6, ne: 7, lt: 8, le: 9, gt: 10, ge: 11};
const MODE = {same: 0, aScalar: 1, bScalar: 2, general: 3};
const halves = v => [v & 0xffff, v >>> 16];
const OPTIM = {sgd_update: 0, momentum_update: 1, adam_m: 2, adam_v: 3, adam_update: 4};
// Enough invocations to fill a GPU, and the smallest chunk of the reduced axis
// worth giving one. Both are round numbers, not tuned constants: the win is in
// the order of magnitude, and past it the second pass costs more than it saves.
const WIDE_ENOUGH = 65536, MIN_SPLIT_K = 512, MIN_SPLIT_CHUNK = 128, MAX_SPLIT = 32;
const UNIFORMS = ['wO', 'nO', 'wA', 'wB', 'wC', 'wD', 'mode', 'op', 'len', 'd', 'sa', 'sb', 'g', 'f', 'tA', 'tB', 'tC', 'tD'];

/** Fragment-shader compute on float textures: R32F where renderable, else RGBA32F. */
export class WebGL2Backend {
  static async create({debug = false} = {}) {
    const canvas=typeof OffscreenCanvas!=='undefined'?new OffscreenCanvas(1,1):globalThis.document?.createElement('canvas');
    check(canvas, 'UNAVAILABLE', 'No canvas implementation is available');
    const gl=canvas.getContext('webgl2',{powerPreference:'high-performance',failIfMajorPerformanceCaveat:true,
      antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false});
    check(gl,'UNAVAILABLE','WebGL2 is unavailable');
    const debugInfo=gl.getExtension('WEBGL_debug_renderer_info');
    const renderer=String(gl.getParameter(debugInfo?debugInfo.UNMASKED_RENDERER_WEBGL:gl.RENDERER));
    if(/swiftshader|llvmpipe|softpipe|software|microsoft basic render/i.test(renderer)) {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      throw new ComputeError('UNAVAILABLE',`Hardware WebGL2 required; browser reported ${renderer}`);
    }
    if(!gl.getExtension('EXT_color_buffer_float')) {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      throw new ComputeError('UNAVAILABLE','WebGL2 floating-point render targets are unavailable');
    }
    return new WebGL2Backend(gl,canvas,{debug});
  }
  constructor(gl,canvas,{debug=false}={}) {
    this.name='webgl2';this.gl=gl;this.canvas=canvas;this.debug=debug;this.programs=new Map();this.lost=false;
    this.textureBytes=0;this.peakTextureBytes=0;this.maxTextureBytes=DEFAULT_LIMITS.maxWebGLTextureBytes;this.pool=new Map();this.pooledBytes=0;
    const debugInfo=gl.getExtension('WEBGL_debug_renderer_info');
    this.info={description:String(gl.getParameter(debugInfo?debugInfo.UNMASKED_RENDERER_WEBGL:gl.RENDERER)),
      vendor:String(gl.getParameter(debugInfo?debugInfo.UNMASKED_VENDOR_WEBGL:gl.VENDOR)),powerPreference:gl.getContextAttributes()?.powerPreference};
    this.maxTexture=gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const viewport=gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    this.maxWidth=Math.min(this.maxTexture,viewport[0]);this.maxHeight=Math.min(this.maxTexture,viewport[1]);
    this.framebuffer=gl.createFramebuffer();this.vao=gl.createVertexArray();
    canvas.addEventListener?.('webglcontextlost',()=>{this.lost=true;});
    gl.disable(gl.DEPTH_TEST);gl.disable(gl.BLEND);gl.disable(gl.DITHER);gl.bindVertexArray(this.vao);
    // One scalar per texel. R32F stores it in 4 bytes; RGBA32F is the fallback where R32F is not renderable.
    this.r32f=this.renderable(gl.R32F,gl.RED);this.texelBytes=this.r32f?4:16;
    // RGBA/FLOAT readback is always allowed; RED/FLOAT (a quarter of the bytes) only where the driver reports it.
    this.readRed=this.r32f&&this.renderable(gl.R32F,gl.RED,true);
    this.description=`WebGL2 fragment shaders on ${this.r32f?'R32F':'RGBA32F'} textures`;
  }
  renderable(internal,format,readsRed=false) {
    const gl=this.gl,t=gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,t);gl.texImage2D(gl.TEXTURE_2D,0,internal,1,1,0,format,gl.FLOAT,null);
    gl.bindFramebuffer(gl.FRAMEBUFFER,this.framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,t,0);
    let ok=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;
    if(ok&&readsRed)ok=gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT)===gl.RED&&gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE)===gl.FLOAT;
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,null,0);gl.deleteTexture(t);gl.getError();
    return ok;
  }
  live(){check(!this.lost&&!this.gl.isContextLost(),'DEVICE_LOST','WebGL context is lost');}
  limitHints(){return {maxElements:Math.min(DEFAULT_LIMITS.maxElements,1024*this.maxHeight),maxWork:500000000};}
  /** Integer accumulation needs 64 bits -- products reach 2^30 and their sums
   * 2^40 -- and GLSL ES has no 64-bit integer type. Until that is emulated in
   * paired u32s, this backend says so rather than returning zeros. See
   * docs/FIXED-POINT.md. */
  unsupported(){return UNSUPPORTED;}
  async begin(plan){this.live();this.maxTextureBytes=plan?.limits.maxWebGLTextureBytes??DEFAULT_LIMITS.maxWebGLTextureBytes;this.peakTextureBytes=this.textureBytes-this.pooledBytes;}
  allocationStats(){return {webglTexturePeakBytes:this.peakTextureBytes,webglTextureFormat:this.r32f?'R32F':'RGBA32F'};}
  /** How many ways to split a product's reduced axis.
   *
   * One fragment per output element is enough parallelism when there are many
   * outputs and not nearly enough when there are a few thousand, which is what
   * every projection in a one-token decode step looks like. The target is
   * simply "enough invocations to fill a GPU"; past that, splitting only adds
   * a second pass. */
  splitParts(n){
    if(n.size>=WIDE_ENOUGH||n.k<MIN_SPLIT_K)return 1;
    const parts=Math.min(Math.ceil(WIDE_ENOUGH/n.size),Math.floor(n.k/MIN_SPLIT_CHUNK),MAX_SPLIT);
    return parts>1?parts:1;
  }
  layout(size){
    // Rows of 1024 keep the addressing cheap and are what every tensor here
    // used to need. A quantized embedding table does not fit that shape: at
    // 151,936 by 1,024 it is 32 million words, which is 31,200 rows against a
    // driver limit that is usually 16,384. So a tensor that would be too tall
    // is widened instead, up to whatever the driver allows.
    let width=Math.min(size,1024,this.maxWidth);
    if(width>0&&Math.ceil(size/width)>this.maxHeight)width=Math.min(this.maxWidth,Math.ceil(size/this.maxHeight));
    width=Math.max(width,1);
    return {width,height:Math.ceil(size/width)};
  }
  /** Deletes pooled textures (oldest first) until `bytes` more fit in the live budget. */
  evict(bytes){
    for(const [key,list] of this.pool){
      while(list.length&&this.textureBytes+bytes>this.maxTextureBytes){const t=list.shift();this.gl.deleteTexture(t.texture);this.textureBytes-=t.bytes;this.pooledBytes-=t.bytes;}
      if(!list.length)this.pool.delete(key);
      if(this.textureBytes+bytes<=this.maxTextureBytes)return;
    }
  }
  /** Blocks of a quantized weight, as an R32UI texture of raw four-byte words.
   * It is only ever sampled, never rendered to, so it needs no renderable
   * format and none of the RGBA32F fallback that floats may need. */
  allocWords(data) {
    // A Q6_K block is 210 bytes, so a buffer of blocks need not be a multiple
    // of four; the tail is padded rather than read short.
    const total=Math.ceil(data.byteLength/4)*4;
    const bytes=total===data.byteLength?data:(()=>{const b=new Uint8Array(total);b.set(data);return b;})();
    return this.alloc(total/4,new Uint32Array(bytes.buffer,bytes.byteOffset,total/4),true);
  }
  alloc(size,data,words=false) {
    this.live();const gl=this.gl,{width,height}=this.layout(size);
    // Pooled by format as well as shape: the storage is immutable once set.
    const key=`${width}x${height}${words?'u':''}`;
    check(height<=this.maxHeight,'LIMIT','Tensor exceeds WebGL texture/viewport limits');
    const bytes=width*height*(words?4:(this.texelBytes??16));
    let texture=this.pool.get(key)?.pop()?.texture;
    if(texture)this.pooledBytes-=bytes;
    else {
      if(this.textureBytes+bytes>this.maxTextureBytes)this.evict(bytes);
      check(this.textureBytes+bytes<=this.maxTextureBytes,'LIMIT',`WebGL texture allocation budget exceeded (${this.r32f?'R32F':'RGBA32F'}, padding and scratch included)`);
      texture=gl.createTexture();check(texture,'GPU','WebGL texture allocation failed');
      gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texStorage2D(gl.TEXTURE_2D,1,words?gl.R32UI:(this.r32f?gl.R32F:gl.RGBA32F),width,height);
      // Only new textures are checked; pooled ones already passed.
      const error=gl.getError();
      if(error!==gl.NO_ERROR){gl.deleteTexture(texture);throw new ComputeError('GPU',`Texture allocation error ${error}`);}
      this.textureBytes+=bytes;
    }
    this.peakTextureBytes=Math.max(this.peakTextureBytes,this.textureBytes-this.pooledBytes);
    const handle={texture,width,height,size,bytes,key,words,freed:false};
    if(data)this.upload(handle,data);
    return handle;
  }
  upload(h,data) {
    const gl=this.gl;gl.bindTexture(gl.TEXTURE_2D,h.texture);
    if(h.words){
      const rows=Math.floor(h.size/h.width),rest=h.size-rows*h.width;
      if(rows)gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,h.width,rows,gl.RED_INTEGER,gl.UNSIGNED_INT,data,0);
      if(rest)gl.texSubImage2D(gl.TEXTURE_2D,0,0,rows,rest,1,gl.RED_INTEGER,gl.UNSIGNED_INT,data,rows*h.width);
    } else if(this.r32f){
      const rows=Math.floor(h.size/h.width),rest=h.size-rows*h.width;
      if(rows)gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,h.width,rows,gl.RED,gl.FLOAT,data,0);
      if(rest)gl.texSubImage2D(gl.TEXTURE_2D,0,0,rows,rest,1,gl.RED,gl.FLOAT,data,rows*h.width);
    } else {
      const rgba=new Float32Array(h.width*h.height*4);for(let i=0;i<h.size;i++)rgba[4*i]=data[i];
      gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,h.width,h.height,gl.RGBA,gl.FLOAT,rgba);
    }
  }
  shader(type,code) {
    const gl=this.gl,s=gl.createShader(type);check(s,'GPU','Shader allocation failed');
    gl.shaderSource(s,code);gl.compileShader(s);
    if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) {
      const reason=gl.getShaderInfoLog(s);gl.deleteShader(s);throw new ComputeError('SHADER',reason||'Shader compilation failed');
    }
    return s;
  }
  program(name) {
    if(this.programs.has(name))return this.programs.get(name);
    const gl=this.gl,[inputs,body]=KERNELS[name];let vs,fs,p;
    try {
      vs=this.shader(gl.VERTEX_SHADER,`#version 300 es
      const vec2 positions[3]=vec2[3](vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.));
      void main(){gl_Position=vec4(positions[gl_VertexID],0.,1.);}`);
      fs=this.shader(gl.FRAGMENT_SHADER,`${PRELUDE}\n${io(inputs)}\n${body}`);p=gl.createProgram();check(p,'GPU','Program allocation failed');
      gl.attachShader(p,vs);gl.attachShader(p,fs);gl.linkProgram(p);
      check(gl.getProgramParameter(p,gl.LINK_STATUS),'SHADER',gl.getProgramInfoLog(p)||'Shader link failed');
      const entry={program:p,inputs:inputs.length,loc:Object.fromEntries(UNIFORMS.map(u=>[u,gl.getUniformLocation(p,u)]))};
      this.programs.set(name,entry);return entry;
    } catch(error) {if(p)gl.deleteProgram(p);throw error;}
    finally {if(vs)gl.deleteShader(vs);if(fs)gl.deleteShader(fs);}
  }
  attach(h) {
    const gl=this.gl;gl.bindFramebuffer(gl.FRAMEBUFFER,this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,h.texture,0);
    if(this.debug)check(gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE,'GPU','Float framebuffer is incomplete');
  }
  /** One draw over the output texture. Driver errors are checked at readback, or here in debug mode. */
  dispatch(kernel,uniforms,inputs,out) {
    this.live();const gl=this.gl,p=this.program(kernel),loc=p.loc;
    gl.useProgram(p.program);this.attach(out);gl.viewport(0,0,out.width,out.height);
    inputs.forEach((h,i)=>{const name=SAMPLERS[i];gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,h.texture);
      if(loc[`t${name}`])gl.uniform1i(loc[`t${name}`],i);if(loc[`w${name}`])gl.uniform1i(loc[`w${name}`],h.width);});
    gl.uniform1i(loc.wO,out.width);gl.uniform1i(loc.nO,out.size);
    for(const [name,value] of Object.entries(uniforms)){
      const l=loc[name];if(!l)continue;
      if(name==='f')gl.uniform4fv(l,value);else if(Array.isArray(value))gl.uniform4iv(l,value);else gl.uniform1i(l,value);
    }
    gl.drawArrays(gl.TRIANGLES,0,3);
    if(this.debug){const error=gl.getError();check(error===gl.NO_ERROR,'GPU',`WebGL dispatch error ${error} in ${kernel}`);}
  }
  pairwise(input,out) {
    const scratch=[];
    try {
      if(input.size===1){this.dispatch('scale',{f:[1,0,0,0]},[input],out);return;}
      while(input.size>1){const length=Math.ceil(input.size/2),next=length===1?out:this.alloc(length);
        if(next!==out)scratch.push(next);
        this.dispatch('pair',{len:input.size},[input],next);input=next;
      }
    } finally {for(const h of scratch)this.free(h);}
  }
  /** Row maxima, then row sums of exp(x - max), each an [rows] texture. */
  rowStats(a,rows,cols) {
    const max=this.alloc(rows);let sum=null;
    try {
      this.dispatch('row_max',{len:cols},[a],max);sum=this.alloc(rows);this.dispatch('row_sum',{len:cols},[a,max],sum);
      return {max,sum};
    } catch(error){this.free(max);if(sum)this.free(sum);throw error;}
  }
  async run(n,refs) {
    if(n.op==='input')return n.quant?this.allocWords(n.data):this.alloc(n.size,n.data);
    const out=this.alloc(n.size),[a]=refs;
    try {
      switch(n.op) {
        case 'full':this.dispatch('fill',{f:[n.value,0,0,0]},[],out);break;
        case 'add':case 'sub':case 'mul':case 'div':case 'maximum':case 'minimum':
        case 'eq':case 'ne':case 'lt':case 'le':case 'gt':case 'ge':
          this.dispatch('binary',{mode:MODE[n.mode],op:BINARY[n.op],...(n.mode==='general'?{d:n.dims,sa:n.aStrides,sb:n.bStrides}:{})},refs,out);break;
        case 'relu':case 'positive':case 'neg':case 'exp':case 'log':case 'sqrt':
        case 'tanh':case 'sigmoid':case 'gelu':case 'gelu_grad':this.dispatch('unary',{op:UNARY[n.op]},refs,out);break;
        case 'transpose':case 'permute':this.dispatch('gather',{d:n.dims,sa:n.srcStrides},refs,out);break;
        case 'slice':this.dispatch('slice',{d:n.boxDims,sa:n.boxStrides,g:[n.offset,0,0,0]},refs,out);break;
        case 'slice_scatter':this.dispatch('slice_scatter',{d:n.dims,sa:n.begin4,sb:n.stride4,g:n.boxDims},refs,out);break;
        case 'index_select':this.dispatch('index_select',{len:n.count,g:[n.len,n.inner,0,0]},refs,out);break;
        case 'index_add':this.dispatch('index_add',{len:n.count,g:[n.len,n.inner,0,0]},refs,out);break;
        case 'gather':this.dispatch('gather_axis',{d:n.dims,sa:n.srcStrides,g:[n.axisStride,n.len,0,0]},refs,out);break;
        case 'scatter_add':this.dispatch('scatter_add',{d:n.dims,sa:n.indexDims,g:[n.axis4,0,0,0]},refs,out);break;
        case 'where':this.dispatch('where',{mode:n.mode==='same'?0:3,d:n.dims,sa:n.cStrides,sb:n.aStrides,g:n.bStrides},refs,out);break;
        case 'uniform':this.dispatch('uniform',{d:[...halves(n.seed),...halves(n.step)]},[],out);break;
        case 'sum':case 'mean':
          if(n.whole){
            if(n.op==='sum'){this.pairwise(a,out);break;}
            const total=this.alloc(1);
            try{this.pairwise(a,total);this.dispatch('scale',{f:[n.inputSize,0,0,0]},[total],out);}finally{this.free(total);}
          } else this.dispatch('reduce',{len:n.len,mode:+(n.op==='mean'),g:[n.inner,0,0,0]},refs,out);
          break;
        case 'softmax':case 'log_softmax':case 'cross_entropy':case 'cross_entropy_grad': {
          const {max,sum}=this.rowStats(a,n.rows,n.cols);
          try {
            if(n.op==='softmax'||n.op==='log_softmax')this.dispatch('softmax',{len:n.cols,mode:+(n.op==='log_softmax')},[a,max,sum],out);
            else if(n.op==='cross_entropy_grad')this.dispatch('ce_grad',{len:n.cols,g:[n.rows,0,0,0]},[a,max,sum,refs[1]],out);
            else {
              const rows=this.alloc(n.rows),total=this.alloc(1);
              try {
                this.dispatch('ce_rows',{len:n.cols},[a,max,sum,refs[1]],rows);
                this.pairwise(rows,total);this.dispatch('scale',{f:[n.rows,0,0,0]},[total],out);
              } finally {this.free(rows);this.free(total);}
            }
          } finally {this.free(max);this.free(sum);}
          break;
        }
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
          'matmul_fixed needs a 64-bit integer accumulator, which WebGL2 has no native type for; run it on the wasm or cpu-js backend');
        case 'matmul':{
          const kernel=n.bQuant?`matmul_${n.bQuant.dtype.replace('_','')}`:n.transposed?'matmul_t':'matmul';
          const parts=this.splitParts(n);
          if(parts===1){this.dispatch(kernel,{g:[n.m,n.k,n.n,n.batch],sa:[n.aBatchStride,n.bBatchStride,0,0]},refs,out);break;}
          const partials=this.alloc(n.size*parts);
          try{
            this.dispatch(kernel+'_split',
              {g:[n.m,n.k,n.n,n.batch],sa:[n.aBatchStride,n.bBatchStride,parts,Math.ceil(n.k/parts)]},refs,partials);
            // `reduce` sums a [parts, outputs] layout straight down the parts.
            this.dispatch('reduce',{len:parts,mode:0,g:[n.size,0,0,0]},[partials],out);
          }finally{this.free(partials);}
          break;
        }
        case 'sgd_update':case 'momentum_update':case 'adam_m':case 'adam_v':case 'adam_update': {
          const scalars={sgd_update:[n.lr],momentum_update:[n.momentum,n.w],adam_m:[n.w],adam_v:[n.beta2,n.w],
            adam_update:[n.stepSize,n.bc2Sqrt,n.eps]}[n.op];
          this.dispatch('optim',{op:OPTIM[n.op],f:[...scalars,0,0,0].slice(0,4)},[refs[0],refs[1],refs[2]??refs[1]],out);break;
        }
        case 'life':this.dispatch('life',{g:[n.shape[0],n.shape[1],0,0]},refs,out);break;
      }
      return out;
    }catch(error){this.free(out);throw error;}
  }
  readInto(h) {
    const gl=this.gl;this.attach(h);
    // readPixels is synchronous. The API remains awaitable, not non-blocking.
    if(this.readRed){const red=new Float32Array(h.width*h.height);gl.readPixels(0,0,h.width,h.height,gl.RED,gl.FLOAT,red);return red.length===h.size?red:red.slice(0,h.size);}
    const rgba=new Float32Array(h.width*h.height*4);
    gl.readPixels(0,0,h.width,h.height,gl.RGBA,gl.FLOAT,rgba);
    const result=new Float32Array(h.size);for(let i=0;i<h.size;i++)result[i]=rgba[i*4];return result;
  }
  async readAll(handles) {
    this.live();const results=handles.map(h=>this.readInto(h));
    // The execution's one driver-error check covers every allocation, draw and readback.
    const error=this.gl.getError();check(error===this.gl.NO_ERROR,'GPU',`WebGL error ${error} during execution or readback`);
    return results;
  }
  async read(h){return (await this.readAll([h]))[0];}
  free(h){
    if(h.freed)return;h.freed=true;
    (this.pool.get(h.key)??this.pool.set(h.key,[]).get(h.key)).push({texture:h.texture,bytes:h.bytes});this.pooledBytes+=h.bytes;
  }
  async finish(){this.live();}
  dispose(){const gl=this.gl;for(const p of this.programs.values())gl.deleteProgram(p.program);this.programs.clear();
    for(const list of this.pool.values())for(const t of list)gl.deleteTexture(t.texture);this.pool.clear();
    gl.deleteFramebuffer(this.framebuffer);gl.deleteVertexArray(this.vao);gl.getExtension('WEBGL_lose_context')?.loseContext();}
}
