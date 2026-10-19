/** Host-side data validation. No guest string is evaluated as JavaScript. */
export class ModelError extends Error {
  constructor(code, message) { super(message); this.name = 'ModelError'; this.code = code; }
}
export function check(ok, code, message) { if (!ok) throw new ModelError(code, message); }
export function plain(value) {
  return value !== null && typeof value === 'object' &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export function fields(value, allowed, required = []) {
  check(plain(value), 'FORMAT', 'Expected a plain object');
  for (const key of Reflect.ownKeys(value)) {
    check(typeof key === 'string' && allowed.includes(key), 'FORMAT', `Unknown field: ${String(key)}`);
    check('value' in Object.getOwnPropertyDescriptor(value, key), 'FORMAT', 'Accessors are not data');
  }
  for (const key of required) check(Object.hasOwn(value, key), 'FORMAT', `Missing field: ${key}`);
}
export function integer(value, min, max, what) {
  check(Number.isSafeInteger(value) && value >= min && value <= max, 'LIMIT', `${what} must be an integer in [${min}, ${max}]`);
  return value;
}
/** A checkpoint or tokenizer family name: data a host compares, never a label
 * it interprets. Two plugins agreeing on the word "transformer" is not a
 * compatible checkpoint, so these are compared for exact equality only.
 */
export function formatId(value, what) {
  check(typeof value === 'string' && value.length <= 64 && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value),
    'FORMAT', `${what} must be a lowercase dotted/hyphenated format identifier`);
  return value;
}
/** How a tokenizer asset reaches the plugin: as one string, as its lines, or
 * as the pairs of a flat JSON object. These are transports, not formats -- the
 * host never reads what a line or a key says. ZIPP's string operations are
 * regular-expression backed, so a plugin scanning a megabyte itself is
 * quadratic; decomposing here is what keeps a real vocabulary loadable.
 */
export const ASSET_FORMS = Object.freeze(['text', 'lines', 'json-pairs']);
export function safePath(path) {
  check(typeof path === 'string' && path.length > 0 && path.length <= 512, 'PATH', 'Invalid asset path');
  const parts = path.split('/');
  check(parts.every(p => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(p) && p !== '.' && p !== '..'),
    'PATH', 'Use a relative, canonical ASCII asset path without dot segments');
  return path;
}
export function shapeSize(shape, limits, allowEmpty = false) {
  check(Array.isArray(shape) && shape.length <= 4, 'SHAPE', 'Only rank 0 through 4 is supported');
  let size = 1;
  for (const d of shape) {
    integer(d, allowEmpty ? 0 : 1, limits.maxDimension, 'Tensor dimension');
    size *= d;
    integer(size, 0, limits.maxTensorElements, 'Tensor elements');
  }
  return size;
}
export const DEFAULT_LIMITS = Object.freeze({
  maxManifestBytes: 256 * 1024, maxHeaderBytes: 4 * 1024 * 1024,
  maxSourceFileBytes: 1024 * 1024, maxSourceBytes: 4 * 1024 * 1024,
  maxSourceFiles: 64, maxWeightFiles: 16, maxTensors: 4096,
  // Tokenizer assets are mounted into the plugin's virtual filesystem. A GPT-2
  // vocabulary is ~800 KB and its merge table ~450 KB, so they cannot live in a
  // manifest; they are still bounded, hashed and counted like everything else.
  maxTokenizerAssets: 8, maxTokenizerFileBytes: 8 * 1024 * 1024, maxTokenizerBytes: 16 * 1024 * 1024,
  maxTokenizerItems: 1048576,
  maxModelFileBytes: 128 * 1024 * 1024, maxModelBytes: 256 * 1024 * 1024,
  maxDecodedBytes: 64 * 1024 * 1024, maxBoundInputBytes: 64 * 1024 * 1024,
  maxTensorElements: 4194304, maxDimension: 65536,
  // A real checkpoint is deeper than a fixture: eight GPT-Neo layers emit 529
  // nodes, and the count grows with depth, not context. The compute runtime has
  // its own node budget and both must admit a graph, so raising this alone
  // changes nothing -- the host passes matching limits to createRuntime.
  maxGraphBytes: 4 * 1024 * 1024, maxNodes: 4096,
  maxContext: 512, maxNewTokens: 128, maxPromptChars: 16384,
  // Renewed per plugin call. A real tokenizer is the expensive one: reading a
  // 50,000-entry vocabulary and its merge table costs far more than the engine
  // default, and the engine derives a regular expression's step ceiling from
  // what is left of this, so an exhausted budget surfaces as a regex failure
  // rather than an obvious one. The engine's own ceiling is 2e9; the outer
  // Worker deadline, not this, is what bounds wall-clock time.
  instructionBudget: 500000000,
});
export function resolveLimits(overrides = {}) {
  fields(overrides, Object.keys(DEFAULT_LIMITS));
  for (const [k, v] of Object.entries(overrides)) integer(v, 1, Number.MAX_SAFE_INTEGER, k);
  return Object.freeze({...DEFAULT_LIMITS, ...overrides});
}
export function sameShape(a, b) { return a.length === b.length && a.every((d, i) => d === b[i]); }
export function checkHash(hash) { check(typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash), 'HASH', 'Expected lowercase SHA-256'); }
export async function sha256(bytes) {
  check(globalThis.crypto?.subtle, 'HOST', 'Web Crypto is required (HTTPS or localhost)');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
}
export function abortCheck(signal) {
  if (signal?.aborted) throw new ModelError('ABORTED', 'Generation cancelled');
}
