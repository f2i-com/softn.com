import {check, fields, integer, safePath, sha256, checkHash, resolveLimits, formatId, ASSET_FORMS} from './common.mjs';
import {decodeUTF8, parseJSON} from './json.mjs';
import {readAll, FileMapSource, fetchPinned} from './sources.mjs';

export function validatePluginManifest(manifest, limits = resolveLimits()) {
  const required = ['format', 'version', 'id', 'plugin_version', 'entry', 'capabilities',
    'checkpoint_format', 'tokenizer_formats', 'sources'];
  fields(manifest, [...required, 'native'], required);
  check(manifest.format === 'zipp.python-model-plugin' && manifest.version === 1, 'VERSION', 'Unsupported plugin manifest');
  check(typeof manifest.id === 'string' && /^[a-z][a-z0-9.-]{2,95}$/.test(manifest.id), 'FORMAT', 'Invalid plugin id');
  check(typeof manifest.plugin_version === 'string' && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(manifest.plugin_version), 'VERSION', 'Use an exact x.y.z plugin version');
  check(typeof manifest.entry === 'string' && /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(manifest.entry), 'FORMAT', 'Entry must be a Python module name');
  check(Array.isArray(manifest.capabilities) && manifest.capabilities.length === 1 && manifest.capabilities[0] === 'graph-v2',
    'CAPABILITY', 'This host admits only the graph-v2 model-plugin capability');
  // Declared support, pinned by the same hash chain as the source: it lets a
  // host refuse an incompatible checkpoint before compiling any Python. The
  // installed source must still agree (ModelSession checks `describe`).
  formatId(manifest.checkpoint_format, 'Plugin checkpoint format');
  check(Array.isArray(manifest.tokenizer_formats), 'FORMAT', 'Expected a tokenizer format list');
  integer(manifest.tokenizer_formats.length, 1, 8, 'Declared tokenizer formats');
  for (const format of manifest.tokenizer_formats) formatId(format, 'Plugin tokenizer format');
  check(new Set(manifest.tokenizer_formats).size === manifest.tokenizer_formats.length, 'FORMAT', 'Duplicate tokenizer format');
  // Optional: the plugin can read a checkpoint folder as the project that
  // published it laid it out, with no manifest written for this host. It names
  // the config file it understands and the tokenizer files it needs; it still
  // decides what any of them mean.
  if (Object.hasOwn(manifest, 'native')) {
    fields(manifest.native, ['config', 'assets'], ['config', 'assets']);
    safePath(manifest.native.config);
    check(manifest.native.assets && typeof manifest.native.assets === 'object' && !Array.isArray(manifest.native.assets),
      'FORMAT', 'Expected a native tokenizer asset map');
    const names = Object.keys(manifest.native.assets);
    integer(names.length, 0, 8, 'Native tokenizer assets');
    for (const name of names) {
      check(/^[a-z][a-z0-9_]{0,31}$/.test(name), 'FORMAT', `Invalid native asset name: ${name}`);
      const asset = manifest.native.assets[name];
      fields(asset, ['path', 'form'], ['path', 'form']);
      safePath(asset.path);
      check(!asset.path.endsWith('.py'), 'FORMAT', 'A tokenizer asset is data, not plugin source');
      check(ASSET_FORMS.includes(asset.form), 'FORMAT', `Unknown tokenizer asset form: ${asset.form}`);
    }
  }
  check(manifest.sources && !Array.isArray(manifest.sources) && typeof manifest.sources === 'object', 'FORMAT', 'Expected source hash map');
  const paths = Object.keys(manifest.sources); integer(paths.length, 1, limits.maxSourceFiles, 'Plugin source files');
  for (const path of paths) {
    safePath(path); check(path.endsWith('.py'), 'FORMAT', 'Plugins contain Python source only');
    check(path.split('/').every((p, i, all) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(i === all.length - 1 ? p.slice(0, -3) : p)), 'PATH', 'Python source paths must be importable module names');
    checkHash(manifest.sources[path]);
  }
  const entry = manifest.entry.replaceAll('.', '/');
  check(Object.hasOwn(manifest.sources, `${entry}.py`) || Object.hasOwn(manifest.sources, `${entry}/__init__.py`), 'FORMAT', 'Plugin entry source is missing');
  return manifest;
}
export const BOOTSTRAP_ENTRY = '__zipp_model_bootstrap.py';
export function bootstrap(entry) {
  // entry was validated as an identifier path, never arbitrary source text.
  // zipp_model_native is defined for every plugin but resolves only for one
  // that implements it; a plugin without native support never has it called.
  // zipp_model_decode_stage is the same arrangement: a plugin whose model can
  // be split across devices implements build_decode_stage, and one that cannot
  // simply never has it asked for.
  check(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(entry), 'FORMAT', 'Invalid entry');
  return `import json\nimport zipp_plugin.${entry} as _plugin\n\ndef zipp_model_describe(config):\n    return json.dumps(_plugin.describe(json.loads(config)))\n\ndef zipp_model_encode(text, tokenizer):\n    return json.dumps(_plugin.encode(text, json.loads(tokenizer)))\n\ndef zipp_model_decode(tokens, tokenizer):\n    return _plugin.decode(json.loads(tokens), json.loads(tokenizer))\n\ndef zipp_model_config(metadata, vocab_size):
    return json.dumps(_plugin.config_from_gguf(json.loads(metadata), json.loads(vocab_size)))

def zipp_model_graph(config, tokens):\n    return json.dumps(_plugin.build_graph(json.loads(config), json.loads(tokens)))\n\ndef zipp_model_decode_graph(config, context):\n    return json.dumps(_plugin.build_decode_graph(json.loads(config), json.loads(context)))\n\ndef zipp_model_asset(name, form, values):\n    _plugin.load_asset(name, form, values)\n\ndef zipp_model_native(config, assets, limits):\n    return json.dumps(_plugin.native_manifest(json.loads(config), json.loads(assets), json.loads(limits)))\n\ndef zipp_model_tensors(config, first_layer=None, last_layer=None):\n    return json.dumps(_plugin.tensor_names(json.loads(config), json.loads(first_layer) if first_layer else None, json.loads(last_layer) if last_layer else None))\n\ndef zipp_model_decode_stage(config, context, first_layer, last_layer, fixed=None, tokens=None):\n    return json.dumps(_plugin.build_decode_stage(json.loads(config), json.loads(context), json.loads(first_layer), json.loads(last_layer), json.loads(fixed) if fixed else None, json.loads(tokens) if tokens else None))\n\ndef zipp_model_prefill_stage(config, tokens, first_layer, last_layer, fixed=None):\n    return json.dumps(_plugin.build_prefill_stage(json.loads(config), json.loads(tokens), json.loads(first_layer), json.loads(last_layer), json.loads(fixed) if fixed else None))\n\ndef zipp_model_stage_manifest(config, first_layer, last_layer, context, fixed=None):\n    return json.dumps(_plugin.describe_stage(json.loads(config), json.loads(first_layer), json.loads(last_layer), json.loads(context), json.loads(fixed) if fixed else None))\n`;
}
export class PluginRegistry {
  #installed = new Map();
  constructor(overrides = {}) { this.limits = resolveLimits(overrides); }
  async install(source, {approve, expectedHash} = {}) {
    // Deliberately mandatory: no auto-install from a model's architecture field.
    check(typeof approve === 'function', 'APPROVAL', 'The host must explicitly approve plugin installation');
    const bytes = await readAll(source, 'plugin.json', this.limits.maxManifestBytes);
    const digest = await sha256(bytes);
    if (expectedHash !== undefined) { checkHash(expectedHash); check(digest === expectedHash, 'HASH', 'Plugin manifest digest mismatch'); }
    const manifest = validatePluginManifest(parseJSON(decodeUTF8(bytes)), this.limits);
    const identity = Object.freeze({id: manifest.id, version: manifest.plugin_version, sha256: digest});
    const support = Object.freeze({
      checkpoint_format: manifest.checkpoint_format,
      tokenizer_formats: Object.freeze([...manifest.tokenizer_formats]),
      native: Object.hasOwn(manifest, 'native')
        ? Object.freeze({config: manifest.native.config,
            assets: Object.freeze(Object.fromEntries(Object.entries(manifest.native.assets)
              .map(([name, asset]) => [name, Object.freeze({...asset})])))})
        : null,
    });
    const key = `${identity.id}@${identity.version}`;
    if (this.#installed.has(key)) {
      const installed = this.#installed.get(key);
      check(installed.identity.sha256 === digest, 'CONFLICT', 'An installed id/version cannot be silently replaced'); return installed;
    }
    check(await approve(identity) === true, 'APPROVAL', 'Plugin installation was not approved');
    const files = Object.create(null); files['zipp_plugin/__init__.py'] = '';
    let sourceBytes = 0;
    for (const [path, expected] of Object.entries(manifest.sources)) {
      sourceBytes += source.size(path); integer(sourceBytes, 0, this.limits.maxSourceBytes, 'Total plugin source bytes');
      const data = await readAll(source, path, this.limits.maxSourceFileBytes);
      check(await sha256(data) === expected, 'HASH', `Python source digest mismatch: ${path}`);
      files[`zipp_plugin/${path}`] = decodeUTF8(data);
    }
    files[BOOTSTRAP_ENTRY] = bootstrap(manifest.entry);
    const installed = Object.freeze({identity, support, files: Object.freeze(files), entry: BOOTSTRAP_ENTRY});
    // Recheck after awaits: another installation may have won the same key.
    const current = this.#installed.get(key);
    if (current) { check(current.identity.sha256 === digest, 'CONFLICT', 'Concurrent plugin version conflict'); return current; }
    this.#installed.set(key, installed); return installed;
  }
  get(id, version) { const plugin = this.#installed.get(`${id}@${version}`); check(plugin, 'PLUGIN', 'Required plugin is not installed'); return plugin; }
  remove(id, version) { return this.#installed.delete(`${id}@${version}`); }
}
/** A website catalogue is host UI, not a package resolver inside Python.
 * The catalogue owner supplies the pinned manifest hash from a trusted page/catalogue.
 */
export async function downloadPluginSource(manifestUrl, manifestHash, {limits = resolveLimits(), signal, origin} = {}) {
  const options = {signal, origin, maxBytes: limits.maxManifestBytes};
  const raw = await fetchPinned(manifestUrl, manifestHash, options);
  const manifest = validatePluginManifest(parseJSON(decodeUTF8(raw)), limits);
  // Resolved the way fetchBytes resolved the manifest, so a relative URL that
  // fetched is also a base its sources can be found against.
  const base = new URL('.', new URL(manifestUrl, globalThis.location?.href)), entries = new Map([['plugin.json', raw]]); let total = 0;
  for (const [path, digest] of Object.entries(manifest.sources)) {
    const bytes = await fetchPinned(new URL(safePath(path), base), digest, {...options, maxBytes: Math.max(1, Math.min(limits.maxSourceFileBytes, limits.maxSourceBytes - total))});
    total += bytes.length; check(total <= limits.maxSourceBytes, 'LIMIT', 'Plugin exceeds source budget'); entries.set(path, bytes);
  }
  return new FileMapSource(entries);
}
