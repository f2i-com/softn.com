/**
 * A Qwen3 checkpoint small enough to write in a test: GGUF v3, float32
 * weights from a seeded generator, and a byte-level BPE vocabulary that has
 * every byte, a few merges and the ChatML and `<think>` markers. It answers
 * nonsense, deterministically, which is what a test of the machinery needs.
 */

const enum T { U32 = 4, I32 = 5, F32 = 6, STRING = 8, ARRAY = 9 }

export interface TinyShape {
  hidden: number;
  heads: number;
  kvHeads: number;
  headDim: number;
  ffn: number;
  layers: number;
  context: number;
}

export const TINY: TinyShape = { hidden: 32, heads: 4, kvHeads: 2, headDim: 8, ffn: 64, layers: 2, context: 512 };

/** GPT-2's map from a byte to the printable character standing for it in the vocabulary. */
export function byteToUnicode(): string[] {
  const bs: number[] = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
  }
  const out: string[] = new Array(256);
  bs.forEach((b, i) => { out[b] = String.fromCodePoint(cs[i]); });
  return out;
}

export const SPECIALS = ['<|endoftext|>', '<|im_start|>', '<|im_end|>', '<think>', '</think>'];

class Writer {
  private parts: Uint8Array[] = [];
  length = 0;
  private push(bytes: Uint8Array) { this.parts.push(bytes); this.length += bytes.byteLength; }
  u32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); this.push(b); }
  i32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); this.push(b); }
  u64(v: number) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); this.push(b); }
  f32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); this.push(b); }
  str(s: string) { const b = new TextEncoder().encode(s); this.u64(b.byteLength); this.push(b); }
  raw(b: Uint8Array) { this.push(b); }
  pad(to: number) { const rem = this.length % to; if (rem) this.push(new Uint8Array(to - rem)); }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const p of this.parts) { out.set(p, at); at += p.byteLength; }
    return out;
  }
}

type Value = { type: T.U32; value: number } | { type: T.I32; value: number } | { type: T.F32; value: number }
  | { type: T.STRING; value: string } | { type: T.ARRAY; of: T.STRING; value: string[] } | { type: T.ARRAY; of: T.I32; value: number[] };

function writeValue(w: Writer, v: Value) {
  w.u32(v.type);
  switch (v.type) {
    case T.U32: w.u32(v.value); break;
    case T.I32: w.i32(v.value); break;
    case T.F32: w.f32(v.value); break;
    case T.STRING: w.str(v.value); break;
    case T.ARRAY:
      w.u32(v.of);
      w.u64(v.value.length);
      for (const item of v.value) {
        if (typeof item === 'string') w.str(item);
        else w.i32(item);
      }
      break;
  }
}

function random(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
}

export interface TinyOptions {
  shape?: TinyShape;
  seed?: number;
  architecture?: string;
  /** Add a separate output matrix, which the plugin refuses. */
  untied?: boolean;
}

export interface TinyModel {
  bytes: Uint8Array;
  vocab: string[];
  ids: Record<string, number>;
}

export function tinyQwen3(options: TinyOptions = {}): TinyModel {
  const shape = options.shape ?? TINY;
  const arch = options.architecture ?? 'qwen3';
  const bytes = byteToUnicode();
  const merges = ['Ġ t', 'h e', 'Ġ a', 'i n', 'e r', 'o n', 'Ġt he'];
  const merged = ['Ġt', 'he', 'Ġa', 'in', 'er', 'on', 'Ġthe'];
  const vocab = [...bytes, ...merged, ...SPECIALS];
  const types = [...bytes.map(() => 1), ...merged.map(() => 1), ...SPECIALS.map(() => 3)];
  const ids = Object.fromEntries(vocab.map((t, i) => [t, i]));
  const { hidden, heads, kvHeads, headDim, ffn, layers } = shape;

  const metadata: Array<[string, Value]> = [
    ['general.architecture', { type: T.STRING, value: arch }],
    ['general.name', { type: T.STRING, value: 'tiny' }],
    ['general.alignment', { type: T.U32, value: 32 }],
    [`${arch}.context_length`, { type: T.U32, value: shape.context }],
    [`${arch}.embedding_length`, { type: T.U32, value: hidden }],
    [`${arch}.block_count`, { type: T.U32, value: layers }],
    [`${arch}.feed_forward_length`, { type: T.U32, value: ffn }],
    [`${arch}.attention.head_count`, { type: T.U32, value: heads }],
    [`${arch}.attention.head_count_kv`, { type: T.U32, value: kvHeads }],
    [`${arch}.attention.key_length`, { type: T.U32, value: headDim }],
    [`${arch}.attention.value_length`, { type: T.U32, value: headDim }],
    [`${arch}.attention.layer_norm_rms_epsilon`, { type: T.F32, value: 1e-6 }],
    [`${arch}.rope.freq_base`, { type: T.F32, value: 1000000 }],
    ['tokenizer.ggml.model', { type: T.STRING, value: 'gpt2' }],
    ['tokenizer.ggml.pre', { type: T.STRING, value: 'qwen2' }],
    ['tokenizer.ggml.tokens', { type: T.ARRAY, of: T.STRING, value: vocab }],
    ['tokenizer.ggml.token_type', { type: T.ARRAY, of: T.I32, value: types }],
    ['tokenizer.ggml.merges', { type: T.ARRAY, of: T.STRING, value: merges }],
    ['tokenizer.ggml.eos_token_id', { type: T.U32, value: ids['<|im_end|>'] }],
    ['tokenizer.ggml.padding_token_id', { type: T.U32, value: ids['<|endoftext|>'] }],
  ];

  // Shapes as the model reads them, [rows, width]; GGUF writes them reversed.
  const tensors: Array<[string, number[], number]> = [['token_embd.weight', [vocab.length, hidden], 0.5]];
  if (options.untied) tensors.push(['output.weight', [vocab.length, hidden], 0.5]);
  tensors.push(['output_norm.weight', [hidden], 0]);
  for (let l = 0; l < layers; l++) {
    const b = `blk.${l}.`;
    tensors.push(
      [`${b}attn_norm.weight`, [hidden], 0],
      [`${b}attn_q.weight`, [heads * headDim, hidden], 0.3],
      [`${b}attn_k.weight`, [kvHeads * headDim, hidden], 0.3],
      [`${b}attn_v.weight`, [kvHeads * headDim, hidden], 0.3],
      [`${b}attn_q_norm.weight`, [headDim], 0],
      [`${b}attn_k_norm.weight`, [headDim], 0],
      [`${b}attn_output.weight`, [hidden, heads * headDim], 0.3],
      [`${b}ffn_norm.weight`, [hidden], 0],
      [`${b}ffn_gate.weight`, [ffn, hidden], 0.3],
      [`${b}ffn_up.weight`, [ffn, hidden], 0.3],
      [`${b}ffn_down.weight`, [hidden, ffn], 0.3],
    );
  }

  const next = random(options.seed ?? 7);
  const data = new Writer();
  const infos: Array<{ name: string; dims: number[]; offset: number }> = [];
  for (const [name, dims, scale] of tensors) {
    data.pad(32);
    infos.push({ name, dims, offset: data.length });
    const count = dims.reduce((a, b) => a * b, 1);
    // A norm's weight is one, near enough; a matrix is small noise.
    for (let i = 0; i < count; i++) data.f32(scale === 0 ? 1 + next() * 0.1 : next() * scale);
  }

  const head = new Writer();
  head.raw(new TextEncoder().encode('GGUF'));
  head.u32(3);
  head.u64(infos.length);
  head.u64(metadata.length);
  for (const [key, value] of metadata) { head.str(key); writeValue(head, value); }
  for (const info of infos) {
    head.str(info.name);
    head.u32(info.dims.length);
    for (const d of [...info.dims].reverse()) head.u64(d);
    head.u32(0); // F32
    head.u64(info.offset);
  }
  head.pad(32);
  const out = new Uint8Array(head.length + data.length);
  out.set(head.bytes(), 0);
  out.set(data.bytes(), head.length);
  return { bytes: out, vocab, ids };
}
