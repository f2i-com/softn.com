import {check, fields, integer, shapeSize, resolveLimits, safePath} from './common.mjs';
import {decodeUTF8, parseJSON} from './json.mjs';

const WIDTH = Object.freeze({F32: 4, F16: 2, BF16: 2});
function wellFormedShapeSize(shape) {
  check(Array.isArray(shape) && shape.length <= 32, 'SHAPE', 'Invalid tensor shape');
  let size = 1;
  for (const d of shape) {
    integer(d, 0, Number.MAX_SAFE_INTEGER, 'Tensor dimension');
    size *= d;
    integer(size, 0, Number.MAX_SAFE_INTEGER, 'Tensor elements');
  }
  return size;
}
async function exactRead(source, path, offset, length) {
  const bytes = await source.read(path, offset, length);
  check(bytes instanceof Uint8Array && bytes.length === length, 'SOURCE', 'Truncated tensor read'); return bytes;
}
/** Strict data-only Safetensors index. Weights remain outside the Python VFS. */
export async function openSafetensors(source, path, overrides = {}) {
  const limits = resolveLimits(overrides); safePath(path);
  const size = source.size(path); integer(size, 8, limits.maxModelFileBytes, 'Safetensors file bytes');
  const first = await exactRead(source, path, 0, 8);
  const headerLength = new DataView(first.buffer, first.byteOffset, 8).getBigUint64(0, true);
  check(headerLength >= 2n && headerLength <= BigInt(limits.maxHeaderBytes) && headerLength <= BigInt(size - 8), 'FORMAT', 'Invalid Safetensors header length');
  const n = Number(headerLength), raw = await exactRead(source, path, 8, n);
  check(raw[0] === 123, 'FORMAT', 'Safetensors header must start with {');
  const header = parseJSON(decodeUTF8(raw), {maxChars: limits.maxHeaderBytes});
  check(header && !Array.isArray(header) && typeof header === 'object', 'FORMAT', 'Invalid Safetensors header');
  const tensors = new Map(); const regions = []; let decodedBytes = 0;
  for (const [name, meta] of Object.entries(header)) {
    if (name === '__metadata__') {
      check(meta && typeof meta === 'object' && !Array.isArray(meta) && Object.values(meta).every(v => typeof v === 'string'), 'FORMAT', 'Metadata must be a string-to-string map'); continue;
    }
    check(name.length > 0 && name.length <= 256, 'FORMAT', 'Invalid tensor name');
    fields(meta, ['dtype', 'shape', 'data_offsets'], ['dtype', 'shape', 'data_offsets']);
    // An unreadable dtype is only fatal for a tensor something actually binds.
    // Real checkpoints carry buffers this host never reads -- GPT-Neo ships a
    // BOOL causal mask per layer -- and rejecting the file for a tensor nobody
    // touches would make an otherwise loadable checkpoint unloadable.
    check(typeof meta.dtype === 'string' && /^[A-Z][A-Z0-9_]{0,15}$/.test(meta.dtype), 'DTYPE', 'Invalid dtype name');
    const readable = Object.hasOwn(WIDTH, meta.dtype);
    // The same goes for the shape limits, which bound what this host decodes:
    // a tensor it never reads only needs a shape that is well formed.
    const elements = readable ? shapeSize(meta.shape, limits, true) : wellFormedShapeSize(meta.shape);
    check(Array.isArray(meta.data_offsets) && meta.data_offsets.length === 2, 'FORMAT', 'Invalid tensor offsets');
    const [begin, end] = meta.data_offsets;
    integer(begin, 0, size - 8 - n, 'Tensor start'); integer(end, begin, size - 8 - n, 'Tensor end');
    if (readable) {
      check(end - begin === elements * WIDTH[meta.dtype], 'FORMAT', 'Tensor shape, dtype and byte length disagree');
      // Only what can be decoded is charged to the decode budget.
      decodedBytes += elements * 4; integer(decodedBytes, 0, limits.maxDecodedBytes, 'Decoded model bytes');
    }
    const info = Object.freeze({name, dtype: meta.dtype, shape: Object.freeze([...meta.shape]), elements, begin, end, readable});
    tensors.set(name, info); regions.push(info);
    integer(tensors.size, 1, limits.maxTensors, 'Tensor count');
  }
  // Empty tensors precede nonempty tensors at the same offset.
  regions.sort((a, b) => a.begin - b.begin || a.end - b.end);
  let cursor = 0;
  for (const r of regions) { check(r.begin === cursor, 'FORMAT', 'Tensor data contains a gap or overlap'); cursor = r.end; }
  check(cursor === size - 8 - n, 'FORMAT', 'Unindexed trailing tensor bytes');
  return {path, size, decodedBytes, tensors, async readTensor(name) {
    check(tensors.has(name), 'TENSOR', `Missing tensor: ${name}`);
    const info = tensors.get(name);
    check(info.readable, 'DTYPE', `Cannot read ${name}: dtype ${info.dtype} is unsupported; this host reads F32, F16 and BF16`);
    const bytes = await exactRead(source, path, 8 + n + info.begin, info.end - info.begin);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), data = new Float32Array(info.elements);
    const scratch = new DataView(new ArrayBuffer(4));
    for (let i = 0; i < data.length; i++) {
      let value;
      if (info.dtype === 'F32') value = view.getFloat32(i * 4, true);
      else {
        const bits = view.getUint16(i * 2, true);
        if (info.dtype === 'BF16') { scratch.setUint32(0, bits << 16, true); value = scratch.getFloat32(0, true); }
        else {
          const sign = bits & 0x8000 ? -1 : 1, exponent = (bits >>> 10) & 31, fraction = bits & 1023;
          value = exponent === 0 ? sign * 2 ** -14 * (fraction / 1024)
            : exponent === 31 ? (fraction ? NaN : sign * Infinity)
            : sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
        }
      }
      // Safetensors permits non-finite numbers; ZIPP's graph protocol does not.
      check(Number.isFinite(value), 'NUMBER', `Non-finite weight is unsupported by ZIPP graphs: ${name}`); data[i] = value;
    }
    return data;
  }};
}
/** Per-session cache. Pending reads share one promise and cannot revive a disposed store. */
export class WeightStore {
  #byName = new Map(); #pending = new Map(); #disposed = false; #indexes;
  constructor(indexes, limits) {
    this.#indexes = [...indexes];
    // `decodedBytes` is what an index has decoded so far. A Safetensors index
    // decodes everything it holds, so it reports its whole size here and this
    // sum is the real check. A GGUF index decodes on demand and starts at zero,
    // enforcing the same budget itself as it decodes -- opening a checkpoint you
    // will only read rows of should not cost what decoding all of it would.
    let decoded = 0, bytes = 0;
    for (const index of this.#indexes) {
      decoded += index.decodedBytes; bytes += index.size;
      check(decoded <= limits.maxDecodedBytes && bytes <= limits.maxModelBytes, 'LIMIT', 'Aggregate model budget exceeded');
      for (const [name, info] of index.tensors) {
        check(!this.#byName.has(name), 'TENSOR', `Duplicate tensor across shards: ${name}`);
        this.#byName.set(name, {index, info});
        check(this.#byName.size <= limits.maxTensors, 'LIMIT', 'Aggregate tensor count exceeded');
      }
    }
  }
  /** What the indexes have decoded so far, read now rather than at
   * construction: a GGUF index starts at zero and grows as it decodes. */
  get decodedBytes() {
    return this.#indexes.reduce((sum, index) => sum + index.decodedBytes, 0);
  }
  info(name) {
    check(!this.#disposed, 'DISPOSED', 'Weights have been disposed');
    check(this.#byName.has(name), 'TENSOR', `Missing tensor: ${name}`);
    const info = this.#byName.get(name).info;
    // Refuse here, in binding preflight, rather than after a large read.
    check(info.readable, 'DTYPE', `Cannot bind ${name}: dtype ${info.dtype} is unsupported; this host reads F32, F16 and BF16`);
    return info;
  }
  /** Gather rows without decoding the whole tensor, where the index can.
   * A Safetensors index decodes and slices; a GGUF one reads only those rows. */
  async rows(name, indices) {
    const {index} = this.#byName.get(name) ?? {};
    this.info(name);
    if (typeof index?.readRows !== 'function') return null;
    return index.readRows(name, indices);
  }
  /** The Graph v2 dtype this tensor can stay as on a device, or null if it
   * must be decoded to float32. A Safetensors index has no blocks at all. */
  residentDtype(name) {
    this.info(name);
    const {index} = this.#byName.get(name);
    return typeof index.residentDtype === 'function' ? index.residentDtype(name) : null;
  }
  /** The tensor's own undecoded bytes, for a backend that decodes as it reads. */
  async blocks(name) {
    this.info(name);
    const {index} = this.#byName.get(name);
    check(typeof index.readBlocks === 'function', 'DTYPE',
      `${name} comes from a source with no block form; bind it as a tensor`);
    return index.readBlocks(name);
  }
  async tensor(name) {
    this.info(name);
    if (!this.#pending.has(name)) {
      const promise = this.#byName.get(name).index.readTensor(name).then(data => {
        check(!this.#disposed, 'DISPOSED', 'Weights disposed during read'); return data;
      }).catch(error => { if (this.#pending.get(name) === promise) this.#pending.delete(name); throw error; });
      this.#pending.set(name, promise);
    }
    return this.#pending.get(name);
  }
  dispose() { this.#disposed = true; this.#byName.clear(); this.#pending.clear(); }
}
