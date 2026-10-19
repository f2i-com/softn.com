import {check} from '../graph.mjs';
const BINARY={add:0,sub:1,mul:2,div:3,maximum:4,minimum:5,eq:6,ne:7,lt:8,le:9,gt:10,ge:11},MODE={same:0,aScalar:1,bScalar:2};
const UNARY={relu:0,positive:1,neg:2,exp:3,log:4,sqrt:5,tanh:6,sigmoid:7,gelu:8,gelu_grad:9};
// The kernel takes the format as a number; both pack 256 values to a block.
// 2 is `matmul_fixed` reading a plain f32 weight; the float kernels have
// no such case, because a float weight there is simply `bmm_t`.
const QUANT_DTYPE={q4_k:0,q6_k:1};
// A ceiling, not a reservation: the module's memory grows only as the arena is
// used. It has to admit a real checkpoint -- a 0.6B Qwen3 is 373 MB of blocks,
// and this allocator bumps rather than reclaiming within one execution.
const ARENA=2*1024*1024*1024;
export class WasmBackend {
  static async create({wasmBytes, wasmUrl = new URL('../../wasm/kernels.wasm', import.meta.url)} = {}) {
    if (!wasmBytes) {
      const res = await fetch(wasmUrl); check(res.ok, 'WASM', `WASM fetch failed: ${res.status}`);
      wasmBytes = await res.arrayBuffer();
    }
    const {instance} = await WebAssembly.instantiate(wasmBytes, {});
    return new WasmBackend(instance.exports);
  }
  constructor(exports) {
    this.name = 'wasm'; this.description = 'Compiled no_std Rust kernels in WebAssembly (SIMD)';
    this.e = exports; this.base = Number(exports.__heap_base.value);
    this.cursor = this.base; this.pinned = this.base;
  }
  /** SIMD kernels sustain more work than the JavaScript reference within a frame deadline. */
  limitHints() { return {maxWork: 400000000}; }
  // Everything below `pinned` survives a step. A prepared session uploads its
  // weights once -- that is what preparing is for -- and this arena used to
  // reset to the bottom every step, so those weights were copied back in per
  // token: 372 MB of memcpy for a 0.6B model, against the one thing the
  // interface promises not to do.
  async begin() { this.cursor = this.pinned; }
  alloc(size) { return this.reserve(size*4, {size}); }
  /** Blocks are bytes: a quantized weight is never counted in elements here,
   * which is the whole reason it costs seven times less to keep. */
  allocBytes(bytes) { return this.reserve(bytes, {bytes, quant: true}); }
  reserve(bytes, fields) {
    const ptr = this.cursor; this.cursor += Math.ceil(bytes/16)*16;
    check(this.cursor <= ARENA, 'LIMIT', 'WASM arena limit exceeded');
    const deficit = this.cursor - this.e.memory.buffer.byteLength;
    if (deficit > 0) this.e.memory.grow(Math.ceil(deficit/65536));
    return {ptr, ...fields};
  }
  view(h) { return new Float32Array(this.e.memory.buffer, h.ptr, h.size); }
  bytesView(h) { return new Uint8Array(this.e.memory.buffer, h.ptr, h.bytes); }
  /** Pairwise tree over scratch that is released afterwards; returns the float32 total. */
  pairwise(input) {
    const mark=this.cursor;
    while(input.size>1){const next=this.alloc(Math.ceil(input.size/2));this.e.pair_sum(input.ptr,next.ptr,input.size);input=next;}
    const total=this.view(input)[0];this.cursor=mark;return total;
  }
  async run(n, refs) {
    const e = this.e;
    // A quantized input is copied in as the blocks it is. Nothing expands it:
    // only a transposed matmul reads it, and that decodes as it multiplies.
    if (n.op === 'input' && n.quant) {
      const h = this.allocBytes(n.data.length);
      this.bytesView(h).set(n.data);
      return h;
    }
    const o = this.alloc(n.size), [a, b, c] = refs.map(r => r?.ptr);
    switch(n.op) {
      case 'input': this.view(o).set(n.data); break;
      case 'full': e.fill(o.ptr,n.size,n.value); break;
      case 'add': case 'sub': case 'mul': case 'div': case 'maximum': case 'minimum':
      case 'eq': case 'ne': case 'lt': case 'le': case 'gt': case 'ge':
        if (n.mode !== 'general') e.binary(a,b,o.ptr,n.size,MODE[n.mode],BINARY[n.op]);
        else e.binary_strided(a,b,o.ptr,BINARY[n.op],...n.dims,...n.aStrides,...n.bStrides);
        break;
      case 'relu': case 'positive': case 'neg': case 'exp': case 'log': case 'sqrt':
      case 'tanh': case 'sigmoid': case 'gelu': case 'gelu_grad': e.unary(a,o.ptr,n.size,UNARY[n.op]); break;
      case 'transpose': case 'permute': e.gather4(a,o.ptr,...n.dims,...n.srcStrides); break;
      // Version 4: a slice is the permutation's strided gather, started at the
      // box's first element (its strides may be negative).
      case 'slice': e.gather4(a+4*n.offset,o.ptr,...n.boxDims,...n.boxStrides); break;
      case 'slice_scatter': e.slice_scatter(a,b,o.ptr,n.size,n.offset,...n.boxDims,...n.boxStrides); break;
      case 'index_select': e.index_select(a,b,o.ptr,n.outer,n.len,n.count,n.inner); break;
      case 'index_add': e.index_add(a,b,c,o.ptr,n.outer,n.len,n.count,n.inner); break;
      case 'gather': e.gather_axis(a,b,o.ptr,n.axisStride,n.len,...n.dims,...n.srcStrides); break;
      case 'scatter_add': e.scatter_add(a,b,c,o.ptr,n.size,n.axisStride,n.len,...n.indexDims,...n.dstStrides); break;
      // refs are [condition, a, b]; `c` below is the third pointer, b's.
      case 'where': e.where_strided(a,b,c,o.ptr,...n.dims,...n.cStrides,...n.aStrides,...n.bStrides); break;
      // Seed and step cross as i32 bit patterns; the kernel reads them as u32.
      case 'uniform': e.uniform(o.ptr,n.size,n.seed|0,n.step|0); break;
      case 'matmul':
        if (n.bQuant) {
          // Four decoded columns at a time; the scratch is released with the mark.
          const mark=this.cursor,scratch=this.alloc(4*n.k);
          e.bmm_quant(a,b,o.ptr,scratch.ptr,n.batch,n.m,n.k,n.n,n.aBatchStride,n.bBatchStride,QUANT_DTYPE[n.bQuant.dtype]);
          this.cursor=mark;
        } else if (n.transposed) e.bmm_t(a,b,o.ptr,n.batch,n.m,n.k,n.n,n.aBatchStride,n.bBatchStride);
        else e.bmm(a,b,o.ptr,n.batch,n.m,n.k,n.n,n.aBatchStride,n.bBatchStride);
        break;
      case 'matmul_fixed': {
        // Scratch released with the mark either way: the quantized activations
        // and their per-row scales, and -- in the run-time form only -- a
        // decoded weight row and its quants. The kernel's answer is an integer,
        // so it is identical to the JavaScript reference's, not close to it.
        const mark = this.cursor;
        const qa = this.reserve(n.m * n.k * 2, {}), sa = this.alloc(n.m);
        if (n.bFixed) {
          // Already quantized and resident: `b` is the int16 weight and `c` its
          // scales. Nothing is decoded and nothing is requantized.
          e.bmm_fixed_i16(a, b, c, o.ptr, qa.ptr, sa.ptr, n.batch, n.m, n.k, n.n, n.aBatchStride);
        } else {
          const row = this.alloc(n.k), qw = this.reserve(n.k * 2, {});
          e.bmm_fixed(a, b, o.ptr, row.ptr, qa.ptr, sa.ptr, qw.ptr,
            n.batch, n.m, n.k, n.n, n.aBatchStride, n.bBatchStride,
            n.bQuant ? QUANT_DTYPE[n.bQuant.dtype] : 2);
        }
        this.cursor = mark;
        break;
      }
      case 'life': e.life(a,o.ptr,n.shape[0],n.shape[1]); break;
      case 'sum': case 'mean':
        if (n.whole) {
          // Scratch is temporary: reuse the arena after the output.
          const total=this.pairwise(refs[0]);
          this.view(o)[0]=n.op==='mean'?Math.fround(total/n.inputSize):total;
        } else e.reduce_axis(a,o.ptr,n.outer,n.len,n.inner,+(n.op==='mean'));
        break;
      case 'softmax': case 'log_softmax': e.softmax_rows(a,o.ptr,n.rows,n.cols,+(n.op==='log_softmax')); break;
      case 'cross_entropy': {
        const mark=this.cursor,rows=this.alloc(n.rows);e.ce_rows(a,b,rows.ptr,n.rows,n.cols);
        const total=this.pairwise(rows);this.cursor=mark;this.view(o)[0]=Math.fround(total/n.rows);break;
      }
      case 'cross_entropy_grad': e.ce_grad(a,b,o.ptr,n.rows,n.cols); break;
      case 'sgd_update': e.sgd_update(a,b,o.ptr,n.size,n.lr); break;
      case 'momentum_update': e.momentum_update(a,b,o.ptr,n.size,n.momentum,n.w); break;
      case 'adam_m': e.adam_m(a,b,o.ptr,n.size,n.w); break;
      case 'adam_v': e.adam_v(a,b,o.ptr,n.size,n.beta2,n.w); break;
      case 'adam_update': e.adam_update(a,b,c,o.ptr,n.size,n.stepSize,n.bc2Sqrt,n.eps); break;
    }
    return o;
  }
  async read(h) { return h instanceof Float32Array ? h.slice() : this.view(h).slice(); }
  free() {} // Arena reclaimed between serial graph executions, not individual nodes.
  // Sessions: the arena is reset per step, so a handle that outlives a step is
  // a host copy, uploaded again where a step reads it.
  /**
   * A handle that outlives a step.
   *
   * One allocated contiguously from the pinned frontier stays exactly where it
   * is and is never copied again: a prepared session's static inputs are
   * uploaded in one run of allocations before any step, so that is all of them.
   * Anything else -- a carried cache, an output produced mid-step -- is above
   * this step's working set and has to come back to the host, because the next
   * step will allocate over it.
   */
  persist(h, pin = false) {
    if (h instanceof Float32Array || h instanceof Uint8Array) return h;
    // Only a session's upload pins. A step's first computed node also starts
    // at the frontier, and pinning it would keep every step's scratch forever.
    if (pin && h.ptr === this.pinned) { this.pinned = this.cursor; h.resident = true; return h; }
    return h.quant ? this.bytesView(h).slice() : this.view(h).slice();
  }
  materialize(h) {
    if (h?.resident) return h; // already on this side, and staying
    if (h instanceof Uint8Array) { const o = this.allocBytes(h.length); this.bytesView(o).set(h); return o; }
    if (!(h instanceof Float32Array)) return h;
    const o = this.alloc(h.length); this.view(o).set(h); return o;
  }
  nextStep() { this.cursor = this.pinned; }
  /** Called when no session is left: nothing pinned is referenced any more. */
  unpin() { this.pinned = this.base; this.cursor = this.base; }
  async finish() {}
  dispose() { this.e = null; }
}
