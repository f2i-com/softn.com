import {check, fields, integer, checkHash, sha256, resolveLimits, abortCheck, formatId, safePath, plain, ASSET_FORMS} from './common.mjs';
import {decodeUTF8} from './json.mjs';
import {parseJSON} from './json.mjs';
import {readJSON, readAll} from './sources.mjs';
import {openSafetensors, WeightStore} from './safetensors.mjs';
import {bindGraph} from './bindings.mjs';
import {prepareDecode, stepInputs} from './decode.mjs';

function validateModel(manifest, plugin, limits) {
  fields(manifest, ['format', 'version', 'architecture', 'checkpoint_format', 'config', 'tokenizer', 'weights', 'license'],
    ['format', 'version', 'architecture', 'checkpoint_format', 'config', 'tokenizer', 'weights']);
  check(manifest.format === 'zipp.local-model' && manifest.version === 1, 'VERSION', 'Unsupported local model manifest');
  fields(manifest.architecture, ['id', 'version', 'sha256'], ['id', 'version', 'sha256']);
  checkHash(manifest.architecture.sha256);
  const a = manifest.architecture, p = plugin.identity;
  check(a.id === p.id && a.version === p.version && a.sha256 === p.sha256, 'PLUGIN', 'Model requires a different exact plugin identity; no automatic download');
  check(manifest.config && typeof manifest.config === 'object' && !Array.isArray(manifest.config), 'FORMAT', 'Expected model configuration');
  check(manifest.tokenizer && typeof manifest.tokenizer === 'object' && !Array.isArray(manifest.tokenizer), 'FORMAT', 'Expected tokenizer configuration');
  validateTokenizerAssets(manifest.tokenizer, limits);
  // Checkpoint and tokenizer families, refused here: before an engine exists,
  // before any Python compiles, and without consulting the checkpoint's own
  // metadata. A plugin implements one named checkpoint family. Emitting the
  // same transformer operations is not evidence that another project's tensor
  // names, orientations, attention scaling or tokenization match; that needs a
  // plugin written and verified against those checkpoints.
  formatId(manifest.checkpoint_format, 'Model checkpoint format');
  formatId(manifest.tokenizer.type, 'Model tokenizer format');
  check(manifest.checkpoint_format === plugin.support.checkpoint_format, 'CHECKPOINT',
    `This model is ${manifest.checkpoint_format}; plugin ${p.id}@${p.version} implements ${plugin.support.checkpoint_format} checkpoints only. Install a plugin built for that checkpoint family; shared transformer operations are not checkpoint compatibility.`);
  check(plugin.support.tokenizer_formats.includes(manifest.tokenizer.type), 'TOKENIZER',
    `This model tokenizes with ${manifest.tokenizer.type}; plugin ${p.id}@${p.version} implements ${plugin.support.tokenizer_formats.join(', ')}. A plugin must ship the tokenizer its checkpoints were trained with.`);
  check(Array.isArray(manifest.weights), 'FORMAT', 'Expected weight shard list');
  integer(manifest.weights.length, 1, limits.maxWeightFiles, 'Weight file count');
  const paths = new Set();
  for (const item of manifest.weights) {
    fields(item, ['path', 'sha256'], ['path']);
    check(typeof item.path === 'string' && item.path.endsWith('.safetensors') && !paths.has(item.path), 'FORMAT', 'Expected unique Safetensors paths'); paths.add(item.path);
    if (item.sha256 !== undefined) checkHash(item.sha256);
  }
  return manifest;
}
function validateTokenizerAssets(tokenizer, limits) {
  if (!Object.hasOwn(tokenizer, 'assets')) return;
  const assets = tokenizer.assets;
  check(assets && typeof assets === 'object' && !Array.isArray(assets), 'FORMAT', 'Expected a tokenizer asset map');
  const names = Object.keys(assets);
  integer(names.length, 1, limits.maxTokenizerAssets, 'Tokenizer assets');
  for (const name of names) {
    check(/^[a-z][a-z0-9_]{0,31}$/.test(name), 'FORMAT', `Invalid tokenizer asset name: ${name}`);
    fields(assets[name], ['path', 'sha256', 'form'], ['path']);
    safePath(assets[name].path);
    check(!assets[name].path.endsWith('.py'), 'FORMAT', 'A tokenizer asset is data, not plugin source');
    if (assets[name].sha256 !== undefined) checkHash(assets[name].sha256);
    if (assets[name].form !== undefined) {
      check(ASSET_FORMS.includes(assets[name].form), 'FORMAT', `Unknown tokenizer asset form: ${assets[name].form}`);
    }
  }
}
/** Read each declared asset, verify it, and hand it to the plugin as values.
 * Returns the tokenizer configuration the guest sees -- asset entries become
 * their own names -- and the digest of everything read, for a host to show.
 */
async function deliverTokenizerAssets(engine, source, layout, limits) {
  const delivered = Object.create(null), digests = [];
  let total = 0;
  for (const [name, entry] of Object.entries(layout)) {
    const bytes = await readAll(source, entry.path, limits.maxTokenizerFileBytes);
    total += bytes.byteLength;
    integer(total, 0, limits.maxTokenizerBytes, 'Tokenizer asset bytes');
    const digest = await sha256(bytes);
    if (entry.sha256 !== undefined) check(digest === entry.sha256, 'HASH', `Tokenizer asset digest mismatch: ${name}`);
    let text;
    try { text = decodeUTF8(bytes); }
    catch { check(false, 'FORMAT', `Tokenizer asset ${name} must be UTF-8 text in this version`); }
    const form = entry.form ?? 'text';
    let values;
    if (form === 'text') values = [text];
    else if (form === 'lines') {
      values = text.split('\n');
      if (values.length > 0 && values[values.length - 1] === '') values.pop();
    } else {
      // One item for the object and one per value; the pair count is checked
      // against maxTokenizerItems below, not against parseJSON's default.
      const parsed = parseJSON(text, {maxChars: limits.maxTokenizerFileBytes,
        maxItems: limits.maxTokenizerItems + 1});
      check(plain(parsed), 'FORMAT', `Tokenizer asset ${name} must be a flat JSON object`);
      values = [];
      for (const key of Object.keys(parsed)) {
        const value = parsed[key];
        check(typeof value === 'string' || Number.isSafeInteger(value), 'FORMAT',
          `Tokenizer asset ${name} must map to strings or integers`);
        values.push(key, value);
      }
    }
    integer(values.length, 0, limits.maxTokenizerItems, `Tokenizer asset ${name} items`);
    engine.renewInstructionBudget();
    engine.pythonCall('zipp_model_asset', [name, form, values]);
    delivered[name] = name;
    digests.push(Object.freeze({name, path: entry.path, form, items: values.length,
      bytes: bytes.byteLength, sha256: digest}));
  }
  return {assets: delivered, digests};
}
function present(source, path) {
  try { source.size(path); return true; }
  catch (error) { if (error?.code === 'MISSING') return false; throw error; }
}
/** The weight files of a checkpoint folder: one `model.safetensors`, or every
 * shard a safetensors index names. The index is read for its file names only;
 * which tensor lives where is the reader's business, and a shard the index
 * promises but does not deliver fails when a binding looks for it.
 */
async function discoverShards(source, limits) {
  if (present(source, 'model.safetensors')) return ['model.safetensors'];
  const index = 'model.safetensors.index.json';
  check(present(source, index), 'MISSING',
    'This folder has neither model.safetensors nor model.safetensors.index.json');
  const parsed = await readJSON(source, index, limits.maxManifestBytes);
  const map = parsed?.weight_map;
  check(map && typeof map === 'object' && !Array.isArray(map), 'FORMAT', 'Expected a safetensors weight_map');
  const shards = new Set();
  for (const tensor of Object.keys(map)) {
    const path = map[tensor];
    check(typeof path === 'string' && path.endsWith('.safetensors'), 'FORMAT', 'A shard is a safetensors file');
    safePath(path);
    shards.add(path);
    integer(shards.size, 1, limits.maxWeightFiles, 'Weight file count');
  }
  return [...shards].sort();
}
function parseReply(reply, limit) {
  check(typeof reply === 'string', 'PLUGIN', 'Plugin hook must return a JSON string');
  return parseJSON(reply, {maxChars: limit});
}
export function seededRandom(seed = 1) {
  integer(seed, 0, 0xffffffff, 'Sampling seed'); let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
/**
 * One token from a row of logits.
 *
 * Four controls, applied in the order llama.cpp applies them, because the order
 * changes the answer: a repetition penalty, then top-k, then top-p, then
 * temperature. Every default is inert -- no penalty, no truncation, greedy --
 * so a caller that asks for nothing gets the most likely token, which is what
 * an oracle comparison wants.
 *
 * `recent` is the token ids to penalise, usually the tail of what has been
 * produced so far. The penalty is the CTRL form: divide a positive logit,
 * multiply a negative one, so a token already used has to be *more* likely
 * than before to be chosen again. It applies to greedy decoding too, which is
 * the case that needs it most -- taking the most likely token every time is
 * exactly how a small model ends up saying "yes, again, again, again".
 */
export function sampleLogits(logits, {temperature = 0, topK = 0, topP = 1,
    repetitionPenalty = 1, recent = null, random = Math.random} = {}) {
  check(logits.length > 0, 'SHAPE', 'Empty logits');
  check(Number.isFinite(temperature) && temperature >= 0 && temperature <= 100, 'SAMPLING', 'Invalid temperature');
  check(Number.isFinite(topP) && topP > 0 && topP <= 1, 'SAMPLING', 'top-p is above zero and at most one');
  check(Number.isFinite(repetitionPenalty) && repetitionPenalty >= 1 && repetitionPenalty <= 4,
    'SAMPLING', 'A repetition penalty is between one and four');
  integer(topK, 0, logits.length, 'topK');
  for (let i = 0; i < logits.length; i++) check(Number.isFinite(logits[i]), 'NUMBER', 'Non-finite logits');

  // Penalise what has already been said. The caller's array is never touched.
  let scores = logits;
  if (repetitionPenalty !== 1 && recent && recent.length) {
    scores = Float32Array.from(logits);
    const seen = new Set();
    for (const id of recent) {
      integer(id, 0, logits.length - 1, 'Recent token id');
      if (seen.has(id)) continue;
      seen.add(id);
      scores[id] = scores[id] > 0 ? scores[id] / repetitionPenalty : scores[id] * repetitionPenalty;
    }
  }

  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  if (temperature === 0) return best;

  let indices = Array.from({length: scores.length}, (_, i) => i);
  if (topK > 0 && topK < scores.length) indices = indices.sort((a, b) => scores[b] - scores[a] || a - b).slice(0, topK);

  if (topP < 1) {
    // The smallest set of most likely tokens whose probability reaches topP.
    // Sorted here even when top-k did not, because a prefix of an unsorted
    // list is not a nucleus. Measured before temperature, which comes last:
    // a nucleus taken from the tempered distribution would shrink as the
    // temperature fell, and that is a different sampler.
    const plain = indices.map(i => Math.exp(scores[i] - scores[best]));
    const order = indices.map((id, at) => at).sort((a, b) => plain[b] - plain[a] || indices[a] - indices[b]);
    const total = plain.reduce((a, b) => a + b, 0);
    const kept = [];
    let cumulative = 0;
    for (const at of order) {
      kept.push(indices[at]);
      cumulative += plain[at] / total;
      if (cumulative >= topP) break;
    }
    indices = kept;
  }

  // Subtract before dividing: even a tiny positive temperature cannot overflow
  // the maximum logit to +Infinity. Negative differences may underflow to -Inf.
  const probs = indices.map(i => Math.exp((scores[i] - scores[best]) / temperature));

  const sum = probs.reduce((a, b) => a + b, 0), r = random();
  check(Number.isFinite(r) && r >= 0 && r < 1, 'SAMPLING', 'Random source must return [0,1)');
  let pick = r * sum;
  for (let i = 0; i < indices.length; i++) { pick -= probs[i]; if (pick < 0) return indices[i]; }
  return indices[indices.length - 1];
}

/** One approved Python plugin and one local model per engine/session.
 * Owns engine + model cache, borrows compute runtime. A Worker must own this
 * instance: a Promise timeout cannot interrupt synchronous guest execution.
 */
export class ModelSession {
  #engine; #runtime; #weights; #model; #plugin; #limits; #description; #native = null;
  #decode; #decodeUnavailable = null; #busy = false; #closed = false;
  static async open({source, plugin, engineFactory, runtime, limits: overrides = {}}) {
    const limits = resolveLimits(overrides);
    check(plugin?.identity && plugin?.support && typeof engineFactory === 'function' && typeof runtime?.execute === 'function', 'HOST', 'Supply an installed plugin (identity and declared support), engine factory and ZIPP compute runtime');
    const model = validateModel(await readJSON(source, 'model.json', limits.maxManifestBytes), plugin, limits);
    let total = 0;
    for (const item of model.weights) { const bytes = source.size(item.path); integer(bytes, 8, limits.maxModelFileBytes, 'Weight file bytes'); total += bytes; integer(total, 8, limits.maxModelBytes, 'Aggregate weight bytes'); }
    const indexes = [];
    for (const item of model.weights) {
      // Optional content integrity costs a whole-file read in this first version.
      if (item.sha256 !== undefined) check(await sha256(await readAll(source, item.path, limits.maxModelFileBytes)) === item.sha256, 'HASH', 'Weight digest mismatch');
      indexes.push(await openSafetensors(source, item.path, limits));
    }
    const weights = new WeightStore(indexes, limits); let engine;
    try {
      engine = engineFactory();
      engine.setSyncHostCapabilities([]); engine.setInstructionBudget(limits.instructionBudget);
      engine.initPythonProject({...plugin.files}, plugin.entry, []);
      let tokenizer = model.tokenizer;
      if (Object.hasOwn(tokenizer, 'assets')) {
        const {assets} = await deliverTokenizerAssets(engine, source, tokenizer.assets, limits);
        tokenizer = {...tokenizer, assets};
      }
      const session = new ModelSession(engine, runtime, {...model, tokenizer}, plugin, weights, limits);
      session.#ready(); return session;
    } catch (error) { weights.dispose(); try { engine?.dispose(); } catch {} throw error; }
  }
  /** Open a checkpoint folder as its own project published it: the plugin's
   * declared config file, the shards named by a safetensors index, and the
   * tokenizer files the plugin asks for. Nothing here is pinned, because a
   * folder from someone else carries no pin for this host -- so the host is
   * handed the digests of everything that will be read and must approve them.
   * That is a weaker claim than a pinned model and is deliberately a separate
   * entry point, not a fallback the ordinary path slides into.
   */
  static async openNative({source, plugin, engineFactory, runtime, limits: overrides = {}, approve}) {
    const limits = resolveLimits(overrides);
    check(plugin?.identity && plugin?.support && typeof engineFactory === 'function' && typeof runtime?.execute === 'function',
      'HOST', 'Supply an installed plugin (identity and declared support), engine factory and ZIPP compute runtime');
    check(plugin.support.native, 'PLUGIN', `Plugin ${plugin.identity.id} does not read checkpoint folders directly`);
    check(typeof approve === 'function', 'APPROVAL', 'An unpinned checkpoint must be approved against its digests');
    const native = plugin.support.native;
    const configBytes = await readAll(source, native.config, limits.maxManifestBytes);
    const rawConfig = parseJSON(decodeUTF8(configBytes), {maxChars: limits.maxManifestBytes});
    const shards = await discoverShards(source, limits);
    const digests = []; let totalBytes = 0;
    for (const path of shards) {
      const bytes = await readAll(source, path, limits.maxModelFileBytes);
      totalBytes += bytes.byteLength;
      integer(totalBytes, 8, limits.maxModelBytes, 'Aggregate weight bytes');
      digests.push(Object.freeze({path, bytes: bytes.byteLength, sha256: await sha256(bytes)}));
    }
    // Everything this session is about to read, hashed, before any of it runs.
    // Assets are read and hashed before approval, but only handed to the
    // plugin after it: nothing from the folder reaches guest code unapproved.
    const assetBytes = [];
    for (const [name, entry] of Object.entries(native.assets)) {
      const bytes = await readAll(source, entry.path, limits.maxTokenizerFileBytes);
      assetBytes.push(Object.freeze({name, path: entry.path, form: entry.form,
        bytes: bytes.byteLength, sha256: await sha256(bytes)}));
    }
    const identity = Object.freeze({
      plugin: Object.freeze({...plugin.identity}),
      checkpoint_format: plugin.support.checkpoint_format,
      config: Object.freeze({path: native.config, sha256: await sha256(configBytes)}),
      weights: Object.freeze(digests), assets: Object.freeze(assetBytes),
    });
    check(await approve(identity) === true, 'APPROVAL', 'Loading this checkpoint folder was not approved');
    const indexes = [];
    for (const path of shards) indexes.push(await openSafetensors(source, path, limits));
    const weights = new WeightStore(indexes, limits);
    let engine;
    try {
      engine = engineFactory();
      engine.setSyncHostCapabilities([]); engine.setInstructionBudget(limits.instructionBudget);
      engine.initPythonProject({...plugin.files}, plugin.entry, []);
      const {assets: mounted} = await deliverTokenizerAssets(engine, source, native.assets, limits);
      engine.renewInstructionBudget();
      // The plugin reads the checkpoint's own configuration. Returning one is
      // the plugin asserting it implements this checkpoint; the host never
      // interprets a field of it.
      const reply = parseReply(engine.pythonCall('zipp_model_native',
        [JSON.stringify(rawConfig), JSON.stringify(mounted), JSON.stringify({max_context: limits.maxContext})]),
        limits.maxManifestBytes);
      fields(reply, ['config', 'tokenizer', 'notes'], ['config', 'tokenizer']);
      check(reply.config && typeof reply.config === 'object' && !Array.isArray(reply.config), 'FORMAT', 'Expected model configuration');
      check(reply.tokenizer && typeof reply.tokenizer === 'object' && !Array.isArray(reply.tokenizer), 'FORMAT', 'Expected tokenizer configuration');
      formatId(reply.tokenizer.type, 'Model tokenizer format');
      check(plugin.support.tokenizer_formats.includes(reply.tokenizer.type), 'TOKENIZER',
        `This checkpoint tokenizes with ${reply.tokenizer.type}; plugin ${plugin.identity.id}@${plugin.identity.version} implements ${plugin.support.tokenizer_formats.join(', ')}.`);
      const model = {
        format: 'zipp.local-model', version: 1,
        architecture: {id: plugin.identity.id, version: plugin.identity.version, sha256: plugin.identity.sha256},
        checkpoint_format: plugin.support.checkpoint_format,
        config: reply.config, tokenizer: reply.tokenizer,
        weights: digests.map(entry => ({path: entry.path, sha256: entry.sha256})),
        license: 'Loaded from an unpinned checkpoint folder; its own licence applies',
      };
      const session = new ModelSession(engine, runtime, model, plugin, weights, limits);
      session.#native = identity;
      session.#ready(); return session;
    } catch (error) { weights.dispose(); try { engine?.dispose(); } catch {} throw error; }
  }
  constructor(engine, runtime, model, plugin, weights, limits) {
    this.#engine = engine; this.#runtime = runtime; this.#weights = weights; this.#model = model; this.#plugin = plugin; this.#limits = limits;
  }
  /** Ask the installed source what it is, and refuse anything the manifest,
   * the source and this driver do not all agree on. Both open paths run this,
   * so a checkpoint folder is checked exactly as strictly as a pinned model. */
  #ready() {
    const model = this.#model, plugin = this.#plugin, limits = this.#limits;
    const d = this.#jsonCall('zipp_model_describe', [JSON.stringify(model.config)]);
    const described = ['task', 'checkpoint_format', 'tokenizer_formats', 'vocab_size', 'max_context'];
    // `decode` is optional: a plugin that also builds a cached decode graph says
    // so, and one that only recomputes the context simply does not.
    fields(d, [...described, 'decode'], described);
    check(!Object.hasOwn(d, 'decode') || typeof d.decode === 'boolean', 'FORMAT', 'decode is a flag');
    check(d.task === 'causal-lm', 'TASK', 'This initial session driver supports causal language model plugins');
    // The manifest was trusted to refuse early; the source is what decides.
    // A plugin.json advertising a checkpoint family its Python does not
    // implement fails here rather than running against the wrong weights.
    check(d.checkpoint_format === plugin.support.checkpoint_format, 'PLUGIN',
      'Installed plugin source and plugin.json disagree about the supported checkpoint format');
    check(Array.isArray(d.tokenizer_formats) && d.tokenizer_formats.length === plugin.support.tokenizer_formats.length &&
      d.tokenizer_formats.every((f, i) => f === plugin.support.tokenizer_formats[i]), 'PLUGIN',
      'Installed plugin source and plugin.json disagree about the supported tokenizers');
    integer(d.vocab_size, 2, limits.maxDimension, 'Vocabulary size');
    integer(d.max_context, 1, limits.maxContext, 'Context size');
    integer(model.tokenizer.eos_token_id, 0, d.vocab_size - 1, 'EOS token');
    this.#description = Object.freeze(d);
  }
  get info() {
    return {plugin: {...this.#plugin.identity}, ...this.#description, tokenizer: this.#model.tokenizer.type,
      decodedWeightBytes: this.#weights.decodedBytes, backend: this.#runtime.info?.().backend ?? 'host-supplied',
      // Present only for a checkpoint folder opened without a pin, so a host
      // can keep showing what it approved rather than losing it after loading.
      ...(this.#native ? {unpinned: this.#native} : {}),
      ...(this.#decodeUnavailable ? {decodeUnavailable: this.#decodeUnavailable} : {})};
  }
  #live() { check(!this.#closed && !this.#engine.disposed, 'DISPOSED', 'Model session is closed'); }
  #call(name, args) { this.#live(); this.#engine.renewInstructionBudget(); return this.#engine.pythonCall(name, args); }
  #jsonCall(name, args) { return parseReply(this.#call(name, args), this.#limits.maxGraphBytes); }
  #tokens(tokens) {
    check(Array.isArray(tokens) && tokens.length > 0 && tokens.length <= this.#description.max_context, 'CONTEXT', 'Token context is empty or exceeds the model context');
    for (const t of tokens) integer(t, 0, this.#description.vocab_size - 1, 'Token id');
  }
  async #infer(tokens, signal) {
    this.#tokens(tokens); abortCheck(signal);
    const template = this.#jsonCall('zipp_model_graph', [JSON.stringify(this.#model.config), JSON.stringify(tokens)]);
    const graph = await bindGraph(template, this.#weights, this.#limits); abortCheck(signal); this.#live();
    const result = await this.#runtime.execute(graph, {typedOutputs: true}); abortCheck(signal); this.#live();
    const output = result.outputs?.logits;
    check(output && Array.isArray(output.shape) && output.shape.length === 2 &&
      (output.shape[0] === tokens.length || output.shape[0] === 1) && output.shape[1] === this.#description.vocab_size,
      'SHAPE', 'Plugin must return logits shaped [context or 1, vocab_size]');
    check(output.data instanceof Float32Array && output.data.length === output.shape[0] * output.shape[1], 'SHAPE', 'Expected typed logits data');
    const logits = output.data.slice(-this.#description.vocab_size);
    for (const v of logits) check(Number.isFinite(v), 'NUMBER', 'Non-finite model logits');
    return {logits, stats: result.stats, backend: result.backend};
  }
  async infer(tokens, {signal} = {}) {
    this.#live(); check(!this.#busy, 'BUSY', 'Await the previous model operation'); this.#busy = true;
    try { return await this.#infer([...tokens], signal); } finally { this.#busy = false; }
  }
  /** Prepare the cached decode path once, if the plugin and runtime offer it.
   * Returns null when either does not, and the eager path is used instead. */
  async #prepareDecode() {
    if (this.#decode !== undefined) return this.#decode;
    this.#decode = null;
    if (this.#description.decode !== true) { this.#decodeUnavailable = 'This plugin builds no decode graph'; return null; }
    if (typeof this.#runtime.prepare !== 'function') { this.#decodeUnavailable = 'This runtime cannot prepare a plan'; return null; }
    // Falling back to recomputing the context is correct but much slower, so
    // why it happened is reported rather than left as a mystery.
    try {
      const template = this.#jsonCall('zipp_model_decode_graph',
        [JSON.stringify(this.#model.config), JSON.stringify(this.#description.max_context)]);
      const plan = await prepareDecode(template, this.#weights, this.#limits);
      this.#live();
      const session = await this.#runtime.prepare(plan.program, {resident: plan.resident, typedOutputs: true});
      this.#decode = {plan, session};
      return this.#decode;
    } catch (error) {
      this.#decodeUnavailable = `${error.code ?? 'ERROR'}: ${error.message ?? error}`;
      return null;
    }
  }
  /** Feed one token and read the logits that follow it. */
  async #step(decode, token, position, readback) {
    const step = await stepInputs(decode.plan, this.#weights, {token, position});
    const result = await decode.session.run([step], {readback});
    if (readback.length === 0) return null;
    const output = result.outputs.logits;
    check(output && Array.isArray(output.shape) && output.shape.length === 2 &&
      output.shape[0] === 1 && output.shape[1] === this.#description.vocab_size,
      'SHAPE', 'A decode graph must return logits shaped [1, vocab_size]');
    check(output.data instanceof Float32Array, 'SHAPE', 'Expected typed logits data');
    return {logits: output.data, stats: result.stats, backend: result.backend};
  }
  /** Generation over a carried cache: each token costs one position, not the
   * whole context, and the weights were uploaded once when the plan was
   * prepared. The caches need no clearing between generations -- every position
   * is written before it is ever unmasked, so nothing stale is read. */
  async #generateCached(decode, tokens, {maxNewTokens, temperature, topK, random, signal, onToken}) {
    const context = decode.plan.context;
    check(tokens.length <= context, 'CONTEXT', 'Prompt exceeds the decode context');
    let out = null;
    for (let i = 0; i < tokens.length; i++) {
      abortCheck(signal); this.#live();
      // Only the last prompt token's logits are read: a vocabulary-sized
      // readback per prompt token would cost more than the prefill.
      out = await this.#step(decode, tokens[i], i, i === tokens.length - 1 ? ['logits'] : []);
    }
    const generated = []; let text = '', finishReason = 'length';
    for (let i = 0; i < maxNewTokens; i++) {
      const token = sampleLogits(out.logits, {temperature, topK, random});
      if (token === this.#model.tokenizer.eos_token_id) { finishReason = 'eos'; break; }
      generated.push(token);
      text = this.#call('zipp_model_decode', [JSON.stringify(generated), JSON.stringify(this.#model.tokenizer)]);
      check(typeof text === 'string' && text.length <= this.#limits.maxPromptChars * 4, 'LIMIT', 'Decoded text exceeds output limit');
      if (onToken) await onToken({token, text, count: generated.length, backend: out.backend});
      abortCheck(signal); this.#live();
      const position = tokens.length + i;
      if (position >= context) { finishReason = 'context'; break; }
      out = await this.#step(decode, token, position, ['logits']);
    }
    return {text, tokens: generated, finishReason, backend: out?.backend ?? this.info.backend,
      stats: out?.stats ?? null, cached: true};
  }
  async generate(prompt, {maxNewTokens = 32, temperature = 0, topK = 0, seed = 1, signal, onToken} = {}) {
    this.#live(); check(!this.#busy, 'BUSY', 'Await the previous model operation');
    check(typeof prompt === 'string' && prompt.length <= this.#limits.maxPromptChars, 'LIMIT', 'Prompt exceeds text limit');
    integer(maxNewTokens, 0, this.#limits.maxNewTokens, 'maxNewTokens');
    const random = seededRandom(seed); this.#busy = true;
    try {
      abortCheck(signal);
      const tokens = this.#jsonCall('zipp_model_encode', [prompt, JSON.stringify(this.#model.tokenizer)]); this.#tokens(tokens);
      const decode = await this.#prepareDecode();
      if (decode) return await this.#generateCached(decode, tokens, {maxNewTokens, temperature, topK, random, signal, onToken});
      const generated = []; let text = '', finishReason = 'length', lastStats = null, backend = this.info.backend;
      for (let i = 0; i < maxNewTokens; i++) {
        if (tokens.length > this.#description.max_context) { finishReason = 'context'; break; }
        const out = await this.#infer(tokens, signal); lastStats = out.stats; backend = out.backend;
        const token = sampleLogits(out.logits, {temperature, topK, random});
        if (token === this.#model.tokenizer.eos_token_id) { finishReason = 'eos'; break; }
        generated.push(token); tokens.push(token);
        // Decode the complete generated prefix. This also supports tokenizers
        // whose byte pieces cannot be decoded correctly one token at a time.
        text = this.#call('zipp_model_decode', [JSON.stringify(generated), JSON.stringify(this.#model.tokenizer)]);
        check(typeof text === 'string' && text.length <= this.#limits.maxPromptChars * 4, 'LIMIT', 'Decoded text exceeds output limit');
        if (onToken) await onToken({token, text, count: generated.length, backend});
        abortCheck(signal);
      }
      return {text, tokens: generated, finishReason, backend, stats: lastStats};
    } finally { this.#busy = false; }
  }
  dispose() {
    check(!this.#busy, 'BUSY', 'Await work before disposing; terminate the owning Worker to hard-cancel');
    if (this.#closed) return;
    this.#closed = true;
    try { this.#decode?.session.dispose(); } catch {}
    this.#decode = null;
    this.#weights.dispose(); this.#engine.dispose();
  }
}
