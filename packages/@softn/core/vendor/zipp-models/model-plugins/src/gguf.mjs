import {check, fields, integer, safePath, shapeSize, resolveLimits} from './common.mjs';
import {decodeUTF8, parseJSON} from './json.mjs';
import {requireGgufModule} from './gguf-module.mjs';

/**
 * GGUF as a weight source, alongside Safetensors.
 *
 * The reader and the block dequantizers come from gguf-wasm, which is its own
 * project (https://github.com/f2i-com/gguf-wasm) consumed here as a pinned
 * release; this is the host side of that boundary. What matters
 * about the arrangement is that neither side ever holds the file: the header is
 * parsed from the first few megabytes, and every tensor after that is a byte
 * range this module reads through the same bounded `source` interface a
 * Safetensors model uses. A quantized checkpoint is routinely several
 * gigabytes, so holding one was never an option.
 *
 * Two things follow from the format:
 *
 *   * GGUF writes a shape fastest-varying first, the mirror of the convention
 *     everything here uses. Shapes are reversed on the way in, once, so a
 *     plugin sees `[rows, width]` like every other tensor and never has to know
 *     which file it came from.
 *   * A quantized row is individually addressable, because every block format
 *     packs a whole number of blocks per row. `rows` therefore reads and
 *     dequantizes only the rows asked for. For an embedding table that is the
 *     difference between a few kilobytes and a gigabyte, and it is why a
 *     vocabulary-sized tensor is usable at all.
 *
 * A tensor crosses into a graph one of two ways. `readTensor` decodes it to
 * float32, which is what a format the backends cannot read must do. `readBlocks`
 * hands over the file's own bytes and lets the backend decode inside its
 * matmul, which is what a format they can read should do: 144 bytes per 256
 * values instead of 1024, and the same result. `RESIDENT` says which is which.
 */
const HEADER_FIRST = 1 << 20;
const HEADER_MAX = 64 * 1024 * 1024;

/** GGUF dtype names to the Graph v2 input dtypes that stay blocks on a device.
 * This mirrors `QUANT` in gpu-lab's graph.mjs, which is the authority: a name
 * that drifts out of it is refused there by name rather than silently decoded. */
export const RESIDENT = Object.freeze({
  Q4_K: Object.freeze({dtype: 'q4_k', block: 256, bytes: 144}),
  Q6_K: Object.freeze({dtype: 'q6_k', block: 256, bytes: 210}),
});

/** The block format `weights` keeps `name` in -- its dtype, values a block and
 * bytes a block -- or null if the tensor has to be decoded to float32. */
export function residentFormat(weights, name) {
  const dtype = typeof weights.residentDtype === 'function' ? weights.residentDtype(name) : null;
  return dtype === null ? null : Object.values(RESIDENT).find(f => f.dtype === dtype) ?? null;
}

/** Read the header by doubling until it parses: its size depends on how large
 * the tokenizer vocabulary embedded in the metadata is, which is not known
 * before reading it. */
async function readHeader(source, path, wasm, limits) {
  const size = source.size(path);
  integer(size, 8, Number.MAX_SAFE_INTEGER, 'GGUF file bytes');
  let want = Math.min(HEADER_FIRST, size), error = null;
  while (want <= Math.min(HEADER_MAX, size)) {
    const head = await source.read(path, 0, want);
    try { return {header: new wasm.GgufHeader(head), read: want}; }
    catch (failure) {
      error = failure;
      if (want === size) break;
      want = Math.min(want * 4, size);
    }
  }
  check(false, 'FORMAT', `Could not read a GGUF header from ${path}: ${error?.message ?? error}`);
}

/**
 * Open a GGUF file as a weight index with the same shape `openSafetensors`
 * returns, so everything downstream — the binder, the weight store, the
 * prepared decode plan — is unchanged.
 */
export async function openGGUF(source, path, wasm, overrides = {}) {
  const limits = resolveLimits(overrides);
  safePath(path);
  // A host may hand over the module; otherwise it is found, and a host that
  // never built it gets a refusal saying so rather than a crash. See
  // gguf-module.mjs -- GGUF reading is a separate WebAssembly module and an
  // optional capability.
  if (!wasm) wasm = await requireGgufModule();
  // It comes from another crate and is coupled to this one by the shape of what
  // it returns, not by a version. Every field it reports is checked below, so a
  // changed shape fails by name rather than producing tensors that are quietly
  // wrong.
  check(wasm && typeof wasm.GgufHeader === 'function' && typeof wasm.dequantize === 'function'
    && typeof wasm.supported_dtypes === 'function',
    'HOST', 'That module is not the GGUF one (GgufHeader, dequantize, supported_dtypes)');
  const size = source.size(path);
  const {header, read} = await readHeader(source, path, wasm, limits);
  const listed = parseJSON(header.tensors(), {maxChars: limits.maxHeaderBytes});
  check(Array.isArray(listed) && listed.length > 0, 'FORMAT', 'GGUF file lists no tensors');
  integer(listed.length, 1, limits.maxTensors, 'Tensor count');

  const tensors = new Map();
  // What decoding the whole file would cost, which for a quantized checkpoint
  // is several times the file itself. It is reported, not enforced: nothing
  // decodes a whole checkpoint here, and charging for it up front would make a
  // file unopenable that a caller only ever reads a few rows of. The budget is
  // charged against what is actually decoded, below.
  let fullyDecodedBytes = 0;
  for (const entry of listed) {
    fields(entry, ['name', 'shape', 'dtype', 'elements', 'offset', 'bytes', 'readable'],
      ['name', 'shape', 'dtype', 'elements', 'offset', 'bytes', 'readable']);
    check(typeof entry.name === 'string' && entry.name.length > 0 && entry.name.length <= 256,
      'FORMAT', 'Invalid tensor name');
    check(!tensors.has(entry.name), 'TENSOR', `Duplicate tensor: ${entry.name}`);
    // Reversed once, here, so no plugin ever needs to know about GGUF's order.
    const shape = Object.freeze([...entry.shape].reverse());
    const elements = shapeSize(shape, limits, true);
    check(elements === entry.elements, 'SHAPE', `Element count disagrees for ${entry.name}`);
    integer(entry.offset, 0, size, 'Tensor start');
    integer(entry.bytes, 0, size - entry.offset, 'Tensor byte length');
    if (entry.readable) fullyDecodedBytes += elements * 4;
    tensors.set(entry.name, Object.freeze({
      name: entry.name, dtype: entry.dtype, shape, elements,
      offset: entry.offset, bytes: entry.bytes, readable: entry.readable === true,
    }));
  }

  // Two kinds of count. `decoded` and `resident` are what the budgets are
  // charged with: every whole tensor handed out, as float32 or as its own
  // blocks, for a caller to hold -- a weight store caches it, a prepared plan
  // uploads it. Each call returns a fresh copy, so each is charged; the index
  // cannot see a caller let one go, so these are an upper bound on what is
  // held rather than a live figure.
  //
  // A gathered row is not held. It is one token's embedding, copied into that
  // step's inputs and dropped, and charging it here would grow the count by a
  // row a token until a long-running host refused its next token with its
  // memory exactly as it was. So a gather is bounded on its own and not
  // accumulated. `bytesRead` and `bytesDecoded` are the other kind: everything
  // this index has read from the file and produced as float32, rows included,
  // for a host that wants to know what the work cost.
  let decoded = 0, resident = 0, bytesRead = 0, bytesDecoded = 0;
  // Checked before it is added, and given back if the read fails: a refusal or
  // a failed read holds nothing, and must not leave the budget smaller.
  function charge(elements, name) {
    check(decoded + elements * 4 <= limits.maxDecodedBytes, 'LIMIT',
      `Decoding ${name} would pass the decoded-weight budget of ${limits.maxDecodedBytes} bytes`);
    decoded += elements * 4;
  }
  async function bytesOf(offset, length) {
    integer(length, 0, limits.maxModelFileBytes, 'Tensor bytes');
    const data = await source.read(path, offset, length);
    check(data instanceof Uint8Array && data.byteLength === length, 'SOURCE', 'Short or invalid read');
    bytesRead += length;
    return data;
  }
  function checked(values, expected, name) {
    check(values instanceof Float32Array || Array.isArray(values), 'SOURCE', 'Expected float data');
    const out = values instanceof Float32Array ? values : Float32Array.from(values);
    check(out.length === expected, 'SHAPE', `Dequantized ${name} has ${out.length} of ${expected} elements`);
    bytesDecoded += out.length * 4;
    for (let i = 0; i < out.length; i++) {
      // The graph protocol admits finite float32 only, and a corrupt block
      // reads as a plausible tensor full of infinities rather than an error.
      check(Number.isFinite(out[i]), 'NUMBER', `Non-finite weight in ${name}`);
    }
    return out;
  }
  function info(name) {
    check(tensors.has(name), 'TENSOR', `Missing tensor: ${name}`);
    const entry = tensors.get(name);
    check(entry.readable, 'DTYPE', `Cannot read ${name}: this build does not decode ${entry.dtype}`);
    return entry;
  }

  return {
    path, size, tensors, format: 'gguf', headerBytes: read,
    // Zero at first: a weight store sums what its indexes have decoded, and
    // nothing has been decoded yet.
    get decodedBytes() { return decoded; },
    get residentBlockBytes() { return resident; },
    // Cumulative, and never charged: see above.
    get bytesRead() { return bytesRead; },
    get bytesDecoded() { return bytesDecoded; },
    fullyDecodedBytes,
    /**
     * The tokenizer this checkpoint was trained with, built inside the module.
     *
     * The vocabulary and merge table stay there: 151,936 strings and 151,387
     * merges are expensive to move and pointless to move, since the only thing
     * that reads them is the encoder. A checkpoint whose `tokenizer.ggml.pre`
     * names a pattern the module does not scan is refused rather than guessed
     * — the wrong pre-tokenizer gives ids that are individually valid and
     * collectively wrong.
     */
    tokenizer() { return header.tokenizer(); },
    /** The file's own metadata, for a plugin that reads its configuration. */
    metadata() { return parseJSON(header.metadata(), {maxChars: limits.maxHeaderBytes}); },
    /** One metadata string array — a tokenizer vocabulary or its merges. */
    strings(key) {
      check(typeof key === 'string', 'FORMAT', 'Expected a metadata key');
      return header.strings(key);
    },
    /** Which Graph v2 dtype this tensor can stay as, or null if it must decode. */
    residentDtype(name) { return RESIDENT[info(name).dtype]?.dtype ?? null; },
    /**
     * The tensor's own bytes, undecoded. Charged against the model-byte budget
     * rather than the decoded-weight one, because that is what it costs.
     */
    async readBlocks(name) {
      const entry = info(name);
      const dtype = RESIDENT[entry.dtype]?.dtype;
      check(dtype !== undefined, 'DTYPE',
        `${name} is ${entry.dtype}; no backend keeps that format resident, so it must be decoded`);
      check(resident + entry.bytes <= limits.maxModelBytes, 'LIMIT',
        `Holding ${name} as blocks would pass the model budget of ${limits.maxModelBytes} bytes`);
      resident += entry.bytes;
      let bytes;
      try { bytes = await bytesOf(entry.offset, entry.bytes); }
      catch (error) { resident -= entry.bytes; throw error; }
      return {dtype, bytes, shape: entry.shape, elements: entry.elements};
    },
    async readTensor(name) {
      const entry = info(name);
      charge(entry.elements, name);
      try {
        return checked(wasm.dequantize(entry.dtype, await bytesOf(entry.offset, entry.bytes), entry.elements),
          entry.elements, name);
      } catch (error) { decoded -= entry.elements * 4; throw error; }
    },
    /** Gather whole rows without decoding the rest of the tensor. */
    async readRows(name, indices) {
      const entry = info(name);
      check(entry.shape.length === 2, 'SHAPE', `Row gathering needs a matrix: ${name}`);
      const width = entry.shape[1];
      // Bounded, not accumulated: a gather is a step's input, not a holding.
      check(indices.length * width * 4 <= limits.maxDecodedBytes, 'LIMIT',
        `Gathering ${indices.length} rows of ${name} would pass the decoded-weight budget of ${limits.maxDecodedBytes} bytes`);
      const out = new Float32Array(indices.length * width);
      for (let i = 0; i < indices.length; i++) {
        integer(indices[i], 0, entry.shape[0] - 1, 'Row index');
        const range = parseJSON(header.row_range(name, indices[i], 1), {maxChars: 512});
        const row = checked(wasm.dequantize(range.dtype, await bytesOf(range.offset, range.bytes), range.elements),
          width, name);
        out.set(row, i * width);
      }
      return out;
    },
  };
}
