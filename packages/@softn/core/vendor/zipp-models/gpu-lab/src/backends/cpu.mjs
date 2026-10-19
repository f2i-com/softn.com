import {gelu, geluGrad, sigmoid, relu, quantizeRow} from '../kernel-math.mjs';
import {uniformKeys, uniformValue} from '../graph.mjs';

/**
 * Reference float32 host-JavaScript implementation, not advertised as WASM.
 * Every operation rounds to float32 (a Float32Array store rounds once). Matrix
 * products and axis reductions accumulate in index order, so the WASM kernels
 * reproduce them bit for bit; transcendental functions are evaluated in double
 * and rounded, so they agree with WASM to about one float32 ulp.
 */
import {blockDecoder, FORMATS, readFixedQuants} from '../quant.mjs';
const f = Math.fround;
const UNARY = {relu, positive: x => x > 0 ? 1 : 0, neg: x => -x, exp: Math.exp, log: Math.log, sqrt: Math.sqrt,
  tanh: Math.tanh, sigmoid, gelu, gelu_grad: geluGrad};
// maximum/minimum: NaN if either operand is NaN, otherwise the larger (smaller)
// with ties -- including -0 against +0 -- going to the first operand, as
// PyTorch's kernels do. Comparisons are 0/1 masks; NaN compares unequal.
const BINARY = {add: (x, y) => x + y, sub: (x, y) => x - y, mul: (x, y) => x * y, div: (x, y) => x / y,
  maximum: (x, y) => (x !== x || y !== y) ? NaN : x < y ? y : x,
  minimum: (x, y) => (x !== x || y !== y) ? NaN : y < x ? y : x,
  eq: (x, y) => x === y ? 1 : 0, ne: (x, y) => x !== y ? 1 : 0, lt: (x, y) => x < y ? 1 : 0,
  le: (x, y) => x <= y ? 1 : 0, gt: (x, y) => x > y ? 1 : 0, ge: (x, y) => x >= y ? 1 : 0};

/** Pairwise float32 reduction: the tree topology the GPU kernels use. */
export function pairwiseSum(a) {
  let work = a;
  while (work.length > 1) {
    const next = new Float32Array(Math.ceil(work.length / 2));
    for (let i = 0; i < next.length; i++) next[i] = work[2*i] + (2*i + 1 < work.length ? work[2*i+1] : 0);
    work = next;
  }
  return work[0];
}
/** Visits every output index of a padded four-dimensional shape with two strided sources. */
function strided(n, out, fn) {
  const [d0, d1, d2, d3] = n.dims, [as0, as1, as2, as3] = n.aStrides ?? n.srcStrides, [bs0, bs1, bs2, bs3] = n.bStrides ?? [0, 0, 0, 0];
  let i = 0;
  for (let x0 = 0; x0 < d0; x0++) for (let x1 = 0; x1 < d1; x1++) for (let x2 = 0; x2 < d2; x2++) {
    const ab = x0*as0 + x1*as1 + x2*as2, bb = x0*bs0 + x1*bs1 + x2*bs2;
    for (let x3 = 0; x3 < d3; x3++) out[i++] = fn(ab + x3*as3, bb + x3*bs3);
  }
}
/** Row-wise max, then the float32 sum of exp(x - max) in index order. */
function rowStats(a, r, cols) {
  let m = a[r*cols];
  for (let j = 1; j < cols; j++) m = Math.max(m, a[r*cols+j]);
  let s = 0;
  for (let j = 0; j < cols; j++) s = f(s + f(Math.exp(f(a[r*cols+j] - m))));
  return [m, s];
}

export class CPUBackend {
  constructor() { this.name = 'cpu-js'; this.description = 'Host JavaScript float32 reference'; }
  async begin() {}
  async run(n, refs) {
    // A quantized input's handle is its blocks. Nothing expands it: that is the
    // point, and only a transposed matmul knows how to read it.
    // An `i16` weight is read out of its little-endian bytes once, here, rather
    // than a pair of bytes at a time inside the product's innermost loop. In a
    // prepared session this runs at `init` and the handle is held, which is the
    // whole point of the format.
    if (n.op === 'input' && n.quant)
      return n.quant.dtype === 'i16' ? readFixedQuants(n.data, n.size) : n.data;
    const out = new Float32Array(n.size), a = refs[0], b = refs[1];
    switch (n.op) {
      case 'input': out.set(n.data); break;
      case 'full': out.fill(n.value); break;
      case 'add': case 'sub': case 'mul': case 'div': case 'maximum': case 'minimum':
      case 'eq': case 'ne': case 'lt': case 'le': case 'gt': case 'ge': {
        const op = BINARY[n.op];
        if (n.mode === 'same') for (let i = 0; i < n.size; i++) out[i] = op(a[i], b[i]);
        else if (n.mode === 'aScalar') { const x = a[0]; for (let i = 0; i < n.size; i++) out[i] = op(x, b[i]); }
        else if (n.mode === 'bScalar') { const y = b[0]; for (let i = 0; i < n.size; i++) out[i] = op(a[i], y); }
        else strided(n, out, (i, j) => op(a[i], b[j]));
        break;
      }
      case 'relu': case 'positive': case 'neg': case 'exp': case 'log': case 'sqrt':
      case 'tanh': case 'sigmoid': case 'gelu': case 'gelu_grad': {
        const op = UNARY[n.op];
        for (let i = 0; i < n.size; i++) out[i] = op(a[i]);
        break;
      }
      case 'transpose': case 'permute': strided(n, out, i => a[i]); break;
      // Version 4. Selections copy values; the two accumulations add each
      // contribution to the base in ascending index position, rounding every
      // addition (a Float32Array store rounds once).
      case 'slice': {
        const off = n.offset;
        strided({dims: n.boxDims, srcStrides: n.boxStrides}, out, i => a[off + i]);
        break;
      }
      case 'slice_scatter': {
        out.set(a);
        const [d0, d1, d2, d3] = n.boxDims, [s0, s1, s2, s3] = n.boxStrides, off = n.offset;
        let i = 0;
        for (let x0 = 0; x0 < d0; x0++) for (let x1 = 0; x1 < d1; x1++) for (let x2 = 0; x2 < d2; x2++) {
          const base = off + x0*s0 + x1*s1 + x2*s2;
          for (let x3 = 0; x3 < d3; x3++) out[base + x3*s3] = b[i++];
        }
        break;
      }
      case 'index_select': {
        const {outer, len, inner, count} = n;
        for (let o = 0, at = 0; o < outer; o++) for (let k = 0; k < count; k++) {
          const from = (o*len + b[k])*inner;
          for (let r = 0; r < inner; r++) out[at++] = a[from + r];
        }
        break;
      }
      case 'index_add': {
        out.set(a);
        const src = refs[1], index = refs[2], {outer, len, inner, count} = n;
        for (let o = 0; o < outer; o++) for (let k = 0; k < count; k++) {
          const to = (o*len + index[k])*inner, from = (o*count + k)*inner;
          for (let r = 0; r < inner; r++) out[to + r] += src[from + r];
        }
        break;
      }
      case 'gather': {
        const stride = n.axisStride;
        let i = 0;
        strided(n, out, j => a[j + b[i++]*stride]);
        break;
      }
      case 'scatter_add': {
        out.set(a);
        // Every index element in row-major order: two that land on one output
        // differ only along the axis, so they arrive in ascending position.
        const src = refs[1], index = refs[2], [d0, d1, d2, d3] = n.indexDims, [s0, s1, s2, s3] = n.dstStrides, stride = n.axisStride;
        let i = 0;
        for (let x0 = 0; x0 < d0; x0++) for (let x1 = 0; x1 < d1; x1++) for (let x2 = 0; x2 < d2; x2++) {
          const base = x0*s0 + x1*s1 + x2*s2;
          for (let x3 = 0; x3 < d3; x3++, i++) { const at = base + x3*s3 + index[i]*stride; out[at] += src[i]; }
        }
        break;
      }
      case 'where': {
        // refs are [condition, a, b]: nonzero (NaN included) picks a.
        const [c, x, y] = refs, [d0, d1, d2, d3] = n.dims, [c0, c1, c2, c3] = n.cStrides;
        const [a0, a1, a2, a3] = n.aStrides, [b0, b1, b2, b3] = n.bStrides;
        let i = 0;
        for (let x0 = 0; x0 < d0; x0++) for (let x1 = 0; x1 < d1; x1++) for (let x2 = 0; x2 < d2; x2++) {
          const cb = x0*c0 + x1*c1 + x2*c2, ab = x0*a0 + x1*a1 + x2*a2, bb = x0*b0 + x1*b1 + x2*b2;
          for (let x3 = 0; x3 < d3; x3++) out[i++] = c[cb + x3*c3] !== 0 ? x[ab + x3*a3] : y[bb + x3*b3];
        }
        break;
      }
      case 'uniform': {
        const [k1, k2] = uniformKeys(n.seed, n.step);
        for (let i = 0; i < n.size; i++) out[i] = uniformValue(k1, k2, i);
        break;
      }
      case 'sum': case 'mean': {
        if (n.whole) {
          const total = pairwiseSum(a);
          out[0] = n.op === 'mean' ? f(total / n.inputSize) : total; break;
        }
        for (let o = 0; o < n.outer; o++) for (let i = 0; i < n.inner; i++) {
          let s = 0;
          for (let j = 0; j < n.len; j++) s = f(s + a[(o*n.len + j)*n.inner + i]);
          out[o*n.inner + i] = n.op === 'mean' ? s / n.len : s;
        }
        break;
      }
      case 'softmax': case 'log_softmax':
        for (let r = 0; r < n.rows; r++) {
          const [m, s] = rowStats(a, r, n.cols), ls = f(Math.log(s));
          for (let j = 0, k = r*n.cols; j < n.cols; j++, k++) {
            const d = f(a[k] - m);
            out[k] = n.op === 'softmax' ? f(Math.exp(d)) / s : d - ls;
          }
        }
        break;
      case 'cross_entropy': case 'cross_entropy_grad': {
        const losses = new Float32Array(n.rows);
        for (let r = 0; r < n.rows; r++) {
          const [m, s] = rowStats(a, r, n.cols), t = b[r];
          if (n.op === 'cross_entropy') { losses[r] = f(Math.log(s)) - f(a[r*n.cols + t] - m); continue; }
          for (let j = 0, k = r*n.cols; j < n.cols; j++, k++)
            out[k] = f(f(f(Math.exp(f(a[k] - m))) / s) - (j === t ? 1 : 0)) / n.rows;
        }
        if (n.op === 'cross_entropy') out[0] = pairwiseSum(losses) / n.rows;
        break;
      }
      case 'matmul': {
        // Every output sums its k products in k order, rounding each step, in
        // all three shapes below. The loops differ in what they walk first, not
        // in what any one output accumulates, so the results are identical.
        const {m, k, n: cols} = n;
        if (n.bQuant) {
          // b holds [N, K] blocks. Each output row of b is decoded once, into
          // scratch, and reused by every row of a: the weight is never expanded.
          const {block: BLOCK, bytes: BYTES} = FORMATS[n.bQuant.dtype];
          const decode = blockDecoder(n.bQuant.dtype);
          const perRow = k / BLOCK, scratch = new Float32Array(k);
          for (let batch = 0; batch < n.batch; batch++) {
            const ao = batch * n.aBatchStride, bo = (batch * n.bBatchStride) / BLOCK, oo = batch * m * cols;
            for (let c = 0; c < cols; c++) {
              for (let t = 0; t < perRow; t++) {
                decode(b, (bo + c * perRow + t) * BYTES, scratch, t * BLOCK);
              }
              for (let r = 0; r < m; r++) {
                const at = oo + r * cols + c, base = ao + r * k;
                for (let j = 0; j < k; j++) out[at] += f(a[base + j] * scratch[j]);
              }
            }
          }
        } else if (n.transposed) {
          // b holds [N, K]: one contiguous row per output column.
          for (let batch = 0; batch < n.batch; batch++) {
            const ao = batch * n.aBatchStride, bo = batch * n.bBatchStride, oo = batch * m * cols;
            for (let r = 0; r < m; r++) {
              for (let c = 0; c < cols; c++) {
                const at = oo + r * cols + c, base = ao + r * k, brow = bo + c * k;
                for (let j = 0; j < k; j++) out[at] += f(a[base + j] * b[brow + j]);
              }
            }
          }
        } else {
          // ikj order over [K, N].
          for (let batch = 0; batch < n.batch; batch++) {
            const ao = batch * n.aBatchStride, bo = batch * n.bBatchStride, oo = batch * m * cols;
            for (let r = 0; r < m; r++) {
              const row = out.subarray(oo + r*cols, oo + (r+1)*cols);
              for (let j = 0; j < k; j++) {
                const x = a[ao + r*k + j], base = bo + j*cols;
                for (let c = 0; c < cols; c++) row[c] += f(x * b[base + c]);
              }
            }
          }
        }
        break;
      }
      case 'matmul_fixed': {
        // Integer accumulation, and therefore the same answer on every backend
        // rather than an answer within a tolerance of another one. See
        // `quantizeRow` for the quantisation this depends on and
        // docs/FIXED-POINT.md for what it costs against float32.
        //
        // Two forms, one answer. Either the weight arrives as float32 or as
        // Q4_K/Q6_K blocks and each output column is decoded and quantized here,
        // on every step -- or it arrives already quantized as `i16` with its
        // scales, and none of that happens at all. `quantizeWeight` produces the
        // second from the first, so they agree bit for bit by being the same
        // arithmetic at a different time.
        const {m, k, n: cols} = n, fixed = n.bFixed;
        const qa = new Int16Array(m * k), sa = new Float32Array(m);
        const qw = fixed ? null : new Int16Array(k), row = fixed ? null : new Float32Array(k);
        const scales = fixed ? refs[2] : null;
        const decode = !fixed && n.bQuant ? blockDecoder(n.bQuant.dtype) : null;
        const BLOCK = decode ? FORMATS[n.bQuant.dtype].block : 0;
        const BYTES = decode ? FORMATS[n.bQuant.dtype].bytes : 0;
        const perRow = decode ? k / BLOCK : 0;
        for (let batch = 0; batch < n.batch; batch++) {
          const ao = batch * n.aBatchStride, oo = batch * m * cols;
          const bo = decode ? (batch * n.bBatchStride) / BLOCK : batch * n.bBatchStride;
          // The activations are quantized once per batch and reused by every
          // output column, the same way the float path reuses a decoded weight
          // row across every row of a.
          for (let r = 0; r < m; r++) sa[r] = quantizeRow(a, ao + r * k, k, qa, r * k);
          for (let c = 0; c < cols; c++) {
            let w, at, sw;
            if (fixed) { w = b; at = c * k; sw = scales[c]; }
            else {
              if (decode) for (let t = 0; t < perRow; t++) decode(b, (bo + c * perRow + t) * BYTES, row, t * BLOCK);
              else for (let j = 0; j < k; j++) row[j] = b[bo + c * k + j];
              // A quantized weight is requantized from what it decodes to, not
              // from the block's own scales: Q4_K and Q6_K carry sub-block
              // scales that no single per-row integer can stand in for, and the
              // scale here has to be the one the accumulator is undone by.
              sw = quantizeRow(row, 0, k, qw, 0); w = qw; at = 0;
            }
            for (let r = 0; r < m; r++) {
              // Exact: each product is under 2^30 and a double is exact to
              // 2^53, which the graph validator checks k against.
              let acc = 0;
              const base = r * k;
              for (let j = 0; j < k; j++) acc += qa[base + j] * w[at + j];
              out[oo + r * cols + c] = f(f(acc) * f(sa[r] * sw));
            }
          }
        }
        break;
      }
      case 'sgd_update': { const lr = n.lr; for (let i = 0; i < n.size; i++) out[i] = a[i] - f(lr * b[i]); break; }
      case 'momentum_update': {
        const mu = n.momentum, w = n.w;
        for (let i = 0; i < n.size; i++) out[i] = f(mu * a[i]) + f(w * b[i]); break;
      }
      case 'adam_m': {
        // torch.lerp(m, grad, 1 - beta1), in the branch PyTorch takes for that weight.
        const w = n.w;
        if (w < 0.5) for (let i = 0; i < n.size; i++) out[i] = a[i] + f(w * f(b[i] - a[i]));
        else { const v = f(1 - w); for (let i = 0; i < n.size; i++) out[i] = b[i] - f(f(b[i] - a[i]) * v); }
        break;
      }
      case 'adam_v': {
        const beta = n.beta2, w = n.w;
        for (let i = 0; i < n.size; i++) out[i] = f(a[i] * beta) + f(f(w * b[i]) * b[i]); break;
      }
      case 'adam_update': {
        const c = refs[2], step = n.stepSize, bc = n.bc2Sqrt, eps = n.eps;
        for (let i = 0; i < n.size; i++) out[i] = a[i] - f(step * f(b[i] / f(f(f(Math.sqrt(c[i])) / bc) + eps)));
        break;
      }
      case 'life': {
        const [h,w] = n.shape;
        for (let y=0;y<h;y++) for(let x=0;x<w;x++) {
          let count=0;
          for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++)
            if(dx || dy) count += a[((y+dy+h)%h)*w+(x+dx+w)%w] > 0.5 ? 1 : 0;
          out[y*w+x] = count===3 || (a[y*w+x]>0.5 && count===2) ? 1 : 0;
        } break;
      }
    }
    return out;
  }
  async read(handle) { return handle.slice(); }
  free() {}
  async finish() {}
  dispose() {}
}
