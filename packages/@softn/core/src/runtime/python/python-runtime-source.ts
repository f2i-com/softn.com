/**
 * The Python that Softn adds to a Python app's project, and nothing else.
 *
 * A Python guest on ZIPP has no preamble, no global slots and no `host.call`:
 * `callFunction`, `evalInContext` and `getGlobalByIndex` all refuse a Python
 * state, and `drainPendingHostCalls` returns nothing. Everything the runtime
 * needs from a JavaScript guest therefore has to be built out of the two calls
 * a Python state does answer — `initPythonProject` and `pythonCall` — which is
 * what this module generates:
 *
 * - `softn.py`, the module the author imports: the `softn.*` capability
 *   facades, an event registry, and the queue a capability call is parked in
 *   until the host drains it. Nothing here reaches the host directly; a call
 *   appends `[id, kind, args]` and the host answers later, exactly as a
 *   JavaScript guest's `host.call` does.
 * - `main.py`, the entry: the five functions the adapter calls by name to read
 *   symbols and state, drain the queue, deliver a callback and dispatch an
 *   event.
 * - one `__softn_set_<module>__` per author module: Python has no way for a
 *   host to write a module global by name, so the setter is generated from a
 *   scan of the module's own column-0 assignments.
 *
 * The value normalizer is deliberately the same dialect as FormLogic's
 * committed `formlogic-python/1` contract (`formlogic.py`): non-finite floats
 * become None, dict keys coerce the way `json.dumps` coerces them, and a depth
 * cap of 64 stops a cycle from becoming a hang. Two Python contracts in one
 * ecosystem would be worse than one, so where this had a choice it made
 * FormLogic's.
 */

/** How one argument of a capability call is encoded before it crosses. */
type ArgEncoding =
  /** `String(x)`: a string passes through, None is "", anything else is JSON. */
  | 's'
  /** `typeof x === "object" ? JSON.stringify(x) : "{}"`: an options bag. */
  | 'o'
  /** `JSON.stringify(x || {})`: a payload that defaults to an empty object. */
  | 'p'
  /** `JSON.stringify(x)`: always JSON, whatever it is. */
  | 'j'
  /** `typeof x === "object" ? JSON.stringify(x) : x`: JSON or the value as text. */
  | 'e';

interface Capability {
  /** Where it lives, e.g. `ai.gpu.createBuffer`. The last part is the method. */
  readonly path: string;
  /** The `host.call` kind, which is what the host's `executeHostCall` switches on. */
  readonly kind: string;
  /** Parameter names and encodings, in order. */
  readonly args: readonly { name: string; encoding: ArgEncoding; literal?: string }[];
}

function cap(path: string, kind: string, args: readonly string[] = []): Capability {
  return {
    path,
    kind,
    args: args.map((spec) => {
      const [name, encoding] = spec.split(':');
      return { name, encoding: encoding as ArgEncoding };
    }),
  };
}

/**
 * Every `softn.*` capability a Python app can reach, and the `host.call` kind
 * it becomes.
 *
 * This is the same list `SOFTN_BRIDGE_PREAMBLE` builds for a JavaScript guest,
 * written once more because Python is a different language, not a different
 * capability set. `python-facade-parity.test.ts` reads every
 * `host.call("<kind>"` out of that preamble and fails if the two lists stop
 * naming the same kinds, so a capability added for one language cannot go
 * missing for the other without a red test.
 *
 * `storage` is not here: its calls all share one kind and build a record out of
 * named parts, so it is generated separately below.
 */
const CAPABILITIES: readonly Capability[] = [
  cap('backend.call', 'backend.call', ['action:s', 'input:p']),
  cap('net.fetch', 'net.fetch', ['url:s', 'options:o']),
  cap('qr.encode', 'qr.encode', ['text:s', 'options:o']),
  cap('qr.decode', 'qr.decode', ['image_data_url:s']),
  cap('camera.capturePhoto', 'camera.capturePhoto', ['options:o']),
  cap('camera.recordVideo', 'camera.recordVideo', ['options:o']),
  cap('camera.startLive', 'camera.startLive', ['options:o']),
  cap('camera.stopLive', 'camera.stopLive'),
  cap('mic.record', 'mic.record', ['options:o']),
  cap('mic.stop', 'mic.stop'),
  cap('mic.isRecording', 'mic.isRecording'),
  cap('audio.speechCapabilities', 'audio.speechCapabilities'),
  cap('audio.loadSpeechModel', 'audio.loadSpeechModel', ['options:p']),
  cap('audio.releaseSpeechModel', 'audio.releaseSpeechModel'),
  cap('audio.speak', 'audio.speak', ['options:p']),
  cap('audio.speechState', 'audio.speechState', ['handle:s']),
  cap('audio.whenSpeechEnded', 'audio.whenSpeechEnded', ['handle:s']),
  cap('audio.stopSpeech', 'audio.stopSpeech', ['handle:s']),
  cap('audio.play', 'audio.play', ['src:s', 'options:o']),
  cap('audio.stop', 'audio.stop', ['handle:s']),
  cap('audio.stopAll', 'audio.stopAll'),
  cap('audio.setVolume', 'audio.setVolume', ['volume:s']),
  cap('audio.whenEnded', 'audio.whenEnded', ['handle:s']),
  cap('input.captureKeys', 'input.captureKeys', ['keys:j']),
  cap('sandbox.run', 'sandbox.run', ['source:s', 'input:j']),
  cap('files.readZipText', 'files.readZipText', ['file_ref:s']),
  cap('files.pickFile', 'files.pickFile', ['options:o']),
  cap('files.readText', 'files.readText', ['file_ref:s']),
  cap('files.readBase64', 'files.readBase64', ['file_ref:s']),
  cap('files.saveFile', 'files.saveFile', ['name:s', 'content:s', 'options:o']),
  cap('ai.getCapabilities', 'ai.getCapabilities'),
  cap('ai.onnx.loadModel', 'ai.onnx.loadModel', ['source:e', 'options:o']),
  cap('ai.onnx.run', 'ai.onnx.run', ['session_id:s', 'feeds:e', 'options:o']),
  cap('ai.onnx.release', 'ai.onnx.release', ['session_id:s']),
  cap('ai.pipeline', 'ai.pipeline', ['task:s', 'model:s', 'options:o']),
  cap('ai.generate', 'ai.generate', ['pipeline_id:s', 'prompt:s', 'options:o']),
  cap('ai.embed', 'ai.embed', ['pipeline_id:s', 'texts:e']),
  cap('ai.classify', 'ai.classify', ['pipeline_id:s', 'text:s']),
  cap('ai.run', 'ai.run', ['pipeline_id:s', 'input:e', 'options:o']),
  cap('ai.releaseAll', 'ai.releaseAll'),
  cap('ai.model.load', 'ai.model.load', ['model_id:s', 'options:o']),
  cap('ai.model.generate', 'ai.model.generate', ['model_handle:s', 'messages:e', 'options:o']),
  cap('ai.model.release', 'ai.model.release', ['model_handle:s']),
  cap('ai.gpu.requestDevice', 'ai.gpu.requestDevice', ['options:o']),
  cap('ai.gpu.createBuffer', 'ai.gpu.createBuffer', ['source:e', 'usage:s']),
  cap('ai.gpu.writeBuffer', 'ai.gpu.writeBuffer', ['buffer_id:s', 'data:e', 'dtype:s']),
  cap('ai.gpu.createShader', 'ai.gpu.createShader', ['source:e']),
  cap('ai.gpu.createPipeline', 'ai.gpu.createPipeline', ['options:e']),
  cap('ai.gpu.dispatch', 'ai.gpu.dispatch', ['pipeline_id:s', 'bindings:j', 'workgroups:j']),
  cap('ai.gpu.readBuffer', 'ai.gpu.readBuffer', ['buffer_id:s']),
  cap('ai.gpu.release', 'ai.gpu.release', ['resource_id:s']),
  cap('ai.gpu.releaseAll', 'ai.gpu.releaseAll'),
];

/** `softn.storage.*`: one kind, one record built from named parts. */
const STORAGE: readonly { method: string; op: string; fields: readonly string[] }[] = [
  { method: 'insert', op: 'insert', fields: ['collection', 'data'] },
  { method: 'get', op: 'get', fields: ['collection', 'id'] },
  { method: 'update', op: 'update', fields: ['collection', 'id', 'data'] },
  { method: 'set', op: 'set', fields: ['collection', 'id', 'data'] },
  { method: 'remove', op: 'remove', fields: ['collection', 'id'] },
  { method: 'count', op: 'count', fields: ['collection', 'where'] },
  { method: 'clear', op: 'clear', fields: ['collection'] },
  { method: 'kvGet', op: 'kvGet', fields: ['key'] },
  { method: 'kvSet', op: 'kvSet', fields: ['key', 'value'] },
  { method: 'kvRemove', op: 'kvRemove', fields: ['key'] },
];

/** The `host.call` kinds a Python guest can reach, for the parity test. */
export const PYTHON_CAPABILITY_KINDS: readonly string[] = [
  ...CAPABILITIES.map((c) => c.kind),
  'storage.op',
];

/** `capturePhoto` → `capture_photo`; already-snake names are unchanged. */
export function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** The encoder call for one argument. */
function encodeArg(arg: { name: string; encoding: ArgEncoding }): string {
  const by: Record<ArgEncoding, string> = {
    s: '_arg_str',
    o: '_arg_options',
    p: '_arg_payload',
    j: '_arg_json',
    e: '_arg_either',
  };
  return `${by[arg.encoding]}(${arg.name})`;
}

/** One namespace class, with every method that belongs directly to it. */
function namespaceClass(namespace: string, members: readonly Capability[], nested: readonly string[]): string {
  const className = `_Ns_${namespace.replace(/\./g, '_')}`;
  const lines: string[] = [`class ${className}:`];
  for (const child of nested) {
    const attribute = child.slice(namespace.length + 1);
    lines.push(`    ${attribute} = _Ns_${child.replace(/\./g, '_')}()`);
  }
  for (const member of members) {
    const method = member.path.slice(namespace.length + 1);
    const python = snakeCase(method);
    const params = member.args.map((a) => `${a.name}=None`).join(', ');
    const signature = params ? `self, ${params}, callback=None` : 'self, callback=None';
    const args = member.args.map(encodeArg).join(', ');
    lines.push(`    def ${python}(${signature}):`);
    lines.push(`        return call(${JSON.stringify(member.kind)}, [${args}], callback)`);
    // The JavaScript spelling too: an author porting a bundle writes the name
    // they already know, and a Python author writes the idiomatic one.
    if (python !== method) lines.push(`    ${method} = ${python}`);
  }
  if (lines.length === 1) lines.push('    pass');
  return lines.join('\n') + '\n';
}

/** The `softn.storage.*` class, whose calls all share one kind. */
function storageClass(): string {
  const lines: string[] = ['class _Ns_storage:'];
  for (const { method, op, fields } of STORAGE) {
    const python = snakeCase(method);
    const params = fields.map((f) => `${f}=None`).join(', ');
    const record = fields.map((f) => `${JSON.stringify(f)}: ${f}`).join(', ');
    lines.push(`    def ${python}(self, ${params}, callback=None):`);
    lines.push(
      `        return call("storage.op", [${JSON.stringify(op)}, _arg_json({${record}})], callback)`
    );
    if (python !== method) lines.push(`    ${method} = ${python}`);
  }
  // `query` takes an options bag and sends the four fields the host reads.
  lines.push('    def query(self, collection=None, options=None, callback=None):');
  lines.push('        q = options if isinstance(options, dict) else {}');
  lines.push('        return call("storage.op", ["query", _arg_json({');
  lines.push('            "collection": collection, "where": q.get("where"),');
  lines.push('            "orderBy": q.get("orderBy"), "limit": q.get("limit"),');
  lines.push('            "offset": q.get("offset"),');
  lines.push('        })], callback)');
  lines.push('    def collections(self, callback=None):');
  lines.push('        return call("storage.op", ["collections", "{}"], callback)');
  return lines.join('\n') + '\n';
}

/** Every namespace, innermost first, so a parent can hold its children. */
function namespaceSources(): string {
  const namespaces = new Map<string, Capability[]>();
  for (const c of CAPABILITIES) {
    const namespace = c.path.slice(0, c.path.lastIndexOf('.'));
    if (!namespaces.has(namespace)) namespaces.set(namespace, []);
    namespaces.get(namespace)!.push(c);
  }
  const names = [...namespaces.keys()];
  // Deepest first: `ai` holds an `_Ns_ai_gpu()` instance, so that class has to
  // exist by the time `class _Ns_ai` is evaluated.
  names.sort((a, b) => b.split('.').length - a.split('.').length || a.localeCompare(b));
  const childrenOf = (name: string) => names.filter((n) => n.startsWith(`${name}.`) && !n.slice(name.length + 1).includes('.'));
  return names.map((name) => namespaceClass(name, namespaces.get(name)!, childrenOf(name))).join('\n');
}

/** The top-level namespace attributes `softn.py` exposes. */
function namespaceBindings(): string {
  // `storage` is generated on its own, so it is named here rather than
  // discovered from the capability table like the rest.
  const roots = new Set<string>(['storage']);
  for (const c of CAPABILITIES) roots.add(c.path.split('.')[0]);
  return [...roots]
    .sort()
    .map((name) => `${name} = _Ns_${name}()`)
    .join('\n');
}

/** The `softn.*` namespaces an app can reach, for the parity test. */
export const PYTHON_NAMESPACES: readonly string[] = [
  ...new Set<string>(['storage', ...CAPABILITIES.map((c) => c.path.split('.')[0])]),
].sort();

/**
 * `softn.py`: the module an app writes `import softn` for.
 *
 * Generated rather than written out so the capability list has one home, and
 * frozen into a constant at module load so every project in a realm gets the
 * same bytes.
 */
export const SOFTN_PY: string = `# Generated by @softn/core. The softn.* capabilities a Python app can reach.
#
# A capability call does not reach the host: it appends [id, kind, args] to a
# queue the host drains after the call returns, and the host answers by calling
# __softn_deliver__ with the id. That is the same shape a JavaScript guest's
# host.call has, so one host serves both languages.
import json as _json
import math as _math

_queue = []
_callbacks = {}
_next = [0]
_listeners = {}
_MAX_DEPTH = 64
# How deep a MIRRORED value may be. Lower than _MAX_DEPTH on purpose and not
# part of the shared dialect: the engine's own boundary carries 32 containers
# and refuses the 33rd, and __softn_state__ spends one of those on the dict it
# answers with. A cap of 64 here would let _project pass a value the boundary
# then rejects — and state is read in one batch, so the whole read would fail
# rather than the one variable, leaving the app blank with nothing said.
# _plain keeps 64 because that is FormLogic's number and its refusal is loud.
_MAX_MIRROR_DEPTH = 30
_SAFE_INTEGER = 9007199254740991


def _plain_key(key):
    # Coerced the way json.dumps coerces keys (formlogic-python/1).
    if isinstance(key, str):
        return key
    if key is None:
        return "null"
    if isinstance(key, bool):
        return "true" if key else "false"
    if isinstance(key, int):
        return str(key)
    if isinstance(key, float):
        if key != key:
            return "NaN"
        if not _math.isfinite(key):
            return "Infinity" if key > 0 else "-Infinity"
        return repr(key)
    raise TypeError("a dict key of type " + type(key).__name__ + " cannot cross; use str keys")


def _plain(value, depth=0):
    """What crosses to the host, refusing anything that would arrive wrong."""
    if depth > _MAX_DEPTH:
        raise ValueError("this value nests deeper than 64 levels")
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        if -_SAFE_INTEGER <= value <= _SAFE_INTEGER:
            return value
        raise ValueError("an integer outside +/-(2**53 - 1) cannot cross; send it as a str")
    if isinstance(value, float):
        return value if _math.isfinite(value) else None
    if isinstance(value, (list, tuple)):
        return [_plain(item, depth + 1) for item in value]
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            out[_plain_key(key)] = _plain(item, depth + 1)
        return out
    raise TypeError("a " + type(value).__name__
                    + " cannot cross; send JSON data (dict, list, str, int, float, bool, None)")


def _project(value, depth=0):
    """What the host MIRRORS as state: the same rules, but lossy rather than loud.

    Reading state must not be able to fail: an app that puts one unsupported
    value in a list, or nests one deeper than the boundary carries, would
    otherwise lose the whole of its state and be unable to say why. Anything
    that cannot cross becomes None, which is what the JavaScript engine's own
    projection does with a function or a class.
    """
    if depth >= _MAX_MIRROR_DEPTH:
        return None
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        # The engine already turns an out-of-range int into its decimal string
        # on the way out; doing it here makes a nested one behave the same.
        return value if -_SAFE_INTEGER <= value <= _SAFE_INTEGER else str(value)
    if isinstance(value, float):
        return value if _math.isfinite(value) else None
    if isinstance(value, (list, tuple)):
        return [_project(item, depth + 1) for item in value]
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            try:
                out[_plain_key(key)] = _project(item, depth + 1)
            except TypeError:
                continue
        return out
    return None


def _dumps(value):
    return _json.dumps(_plain(value))


def _arg_str(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return _dumps(value)


def _arg_options(value):
    return _dumps(value) if isinstance(value, (dict, list)) else "{}"


def _arg_payload(value):
    return _dumps({} if value is None else value)


def _arg_json(value):
    return _dumps(value)


def _arg_either(value):
    return _dumps(value) if isinstance(value, (dict, list)) else _arg_str(value)


def call(kind, args, callback=None):
    """Park one capability call for the host, answering the id it will use."""
    _next[0] = _next[0] + 1
    call_id = _next[0]
    if callback is not None:
        _callbacks[call_id] = callback
    _queue.append([call_id, kind, [_arg_str(a) for a in args]])
    return call_id


def on(event_type, handler):
    """Run handler(event) whenever the host delivers event_type."""
    _listeners.setdefault(event_type, []).append(handler)
    return handler


${namespaceSources()}
${storageClass()}
${namespaceBindings()}
`;

/**
 * `main.py`: the five entry points the adapter calls, and nothing an app would
 * want to name.
 *
 * Every author module is star-imported so a template expression can call a
 * function by its bare name, and held as a module object as well so state can
 * be read and written where it actually lives.
 */
export function mainSource(modules: readonly string[]): string {
  const held = modules.map((m) => `_m_${m}`).join(', ');
  return [
    '# Generated by @softn/core. The host calls only the __softn_*__ names here.',
    'import softn as _softn',
    ...modules.map((m) => `import ${m} as _m_${m}`),
    ...modules.map((m) => `from ${m} import *`),
    ...modules.map((m) => `from ${m} import __softn_set_${m}__`),
    `_MODULES = [${held}]`,
    `_SETTERS = [${modules.map((m) => `__softn_set_${m}__`).join(', ')}]`,
    '_PLAIN = (type(None), bool, int, float, str, list, dict, tuple)',
    '# Names the HOST calls by convention, which an underscore would otherwise',
    '# hide: the renderer runs _init() once after an app loads.',
    '_HOST_NAMES = ("_init",)',
    '',
    '',
    'def _init():',
    '    """The host runs this once after an app loads.',
    '',
    '    A star-import does not carry a name starting with _, so the entry',
    '    module cannot have picked it up with the rest. It forwards instead,',
    '    to whichever module defined one."""',
    '    for m in _MODULES:',
    '        fn = vars(m).get("_init")',
    '        if fn is not None:',
    '            fn()',
    '',
    '',
    'def __softn_symbols__():',
    '    """[name, "function" | "variable", module] for everything an app exposes.',
    '',
    '    A name starting with _ is the module\'s own business. A value that is not',
    '    plain data — a class instance, a module, a file handle — is not offered as',
    '    state, because the host could only ever mirror it as None."""',
    '    result = []',
    '    seen = {}',
    '    for m in _MODULES:',
    '        for k, v in vars(m).items():',
    '            if k == "softn" or type(v).__name__ == "module":',
    '                continue',
    '            if k.startswith("_") and k not in _HOST_NAMES:',
    '                continue',
    '            if callable(v):',
    '                kind = "function"',
    '            elif isinstance(v, _PLAIN):',
    '                kind = "variable"',
    '            else:',
    '                continue',
    '            if k in seen:',
    '                result[seen[k]] = [k, kind, m.__name__]',
    '            else:',
    '                seen[k] = len(result)',
    '                result.append([k, kind, m.__name__])',
    '    return result',
    '',
    '',
    'def __softn_state__(names):',
    '    """The current value of each name, projected to what can cross."""',
    '    result = {}',
    '    for m in _MODULES:',
    '        ns = vars(m)',
    '        for k in names:',
    '            if k in ns:',
    '                result[k] = _softn._project(ns[k])',
    '    return result',
    '',
    '',
    'def __softn_write__(values):',
    '    """Write each name back where it lives; answers how many landed."""',
    '    written = 0',
    '    for k, v in values.items():',
    '        for setter in _SETTERS:',
    '            if setter(k, v):',
    '                written = written + 1',
    '                break',
    '    return written',
    '',
    '',
    'def __softn_drain__():',
    '    """Take the capability calls the last entry queued."""',
    '    taken = list(_softn._queue)',
    '    del _softn._queue[:]',
    '    return taken',
    '',
    '',
    'def __softn_deliver__(call_id, result):',
    '    """Give one queued call its answer. False if nothing was waiting."""',
    '    cb = _softn._callbacks.pop(call_id, None)',
    '    if cb is None:',
    '        return False',
    '    cb(result)',
    '    return True',
    '',
    '',
    'def __softn_listeners__():',
    '    return sorted(_softn._listeners.keys())',
    '',
    '',
    'def __softn_dispatch__(event_type, event):',
    '    n = 0',
    '    for h in list(_softn._listeners.get(event_type, [])):',
    '        h(event)',
    '        n = n + 1',
    '    return n',
    '',
  ].join('\n');
}

/**
 * The names a module assigns at column 0.
 *
 * Python gives a host no way to write another module's global by name, so each
 * module carries a setter generated from this scan. Over-collecting is
 * harmless — a name the module does not really define simply never matches a
 * state variable — which is why a regex is enough and an AST is not needed:
 * the worst a line inside a triple-quoted string can do is add a branch
 * nothing ever takes.
 */
export function scanTopLevelNames(source: string): string[] {
  const names = new Set<string>();
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(
      /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]*)?(?:[-+*/%&|^@]|\/\/|\*\*|<<|>>)?=(?!=)/
    );
    if (match && !match[1].startsWith('_')) names.add(match[1]);
  }
  return [...names];
}

/**
 * `__softn_set_<module>__`, appended to the author's module.
 *
 * Appended rather than prepended so every line of the author's file keeps the
 * number they wrote it at, and an error names the line they can look at.
 */
export function setterSource(module: string, names: readonly string[]): string {
  if (names.length === 0) {
    return `\n\ndef __softn_set_${module}__(name, value):\n    return False\n`;
  }
  const branches = names
    .map((n, i) => `    ${i ? 'elif' : 'if'} name == ${JSON.stringify(n)}:\n        ${n} = value`)
    .join('\n');
  return (
    `\n\ndef __softn_set_${module}__(name, value):\n` +
    `    global ${names.join(', ')}\n${branches}\n    else:\n        return False\n    return True\n`
  );
}
