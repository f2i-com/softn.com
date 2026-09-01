/* @ts-self-types="./zipp_wasm.d.ts" */

/**
 * A compiled script plus the live VM running it.
 */
export class Engine {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EngineFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_engine_free(ptr, 0);
    }
    /**
     * Call the top-level function `name`. Microtasks are drained before this
     * returns, so promise callbacks the call scheduled have already run.
     * @param {string} name
     * @param {any} args
     * @returns {any}
     */
    callFunction(name, args) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_callFunction(this.__wbg_ptr, ptr0, len0, args);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Deliver `event` to every listener registered for `type`, returning how
     * many ran. The event object is given a no-op `preventDefault` if the host
     * did not supply one, since scripts call it unconditionally.
     * @param {string} event_type
     * @param {any} event
     * @returns {number}
     */
    dispatchEvent(event_type, event) {
        const ptr0 = passStringToWasm0(event_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_dispatchEvent(this.__wbg_ptr, ptr0, len0, event);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Tear the VM down. The engine is unusable afterwards.
     */
    dispose() {
        wasm.engine_dispose(this.__wbg_ptr);
    }
    /**
     * Take the `host.call(...)` requests the script queued during the last
     * re-entry, as `[{ id, kind, args }]`.
     * @returns {any}
     */
    drainPendingHostCalls() {
        const ret = wasm.engine_drainPendingHostCalls(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Evaluate `expr` in the script's global context and return its value.
     *
     * Each call compiles fresh and installs stable-address definitions, so this
     * is for one-off host queries — never a per-frame path. Use
     * [`Engine::callFunction`] there.
     * @param {string} expr
     * @returns {any}
     */
    evalInContext(expr) {
        const ptr0 = passStringToWasm0(expr, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_evalInContext(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Event types the script has registered listeners for, e.g. `["keydown"]`.
     * @returns {any}
     */
    getEventListenerTypes() {
        const ret = wasm.engine_getEventListenerTypes(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Read the global in `index`. Values that cannot cross as data (functions,
     * classes, `Map`, `Date`, …) read as `null`.
     * @param {number} index
     * @returns {any}
     */
    getGlobalByIndex(index) {
        const ret = wasm.engine_getGlobalByIndex(this.__wbg_ptr, index);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Read many globals in one boundary crossing.
     * @param {any} indices
     * @returns {any}
     */
    getGlobalsBatch(indices) {
        const ret = wasm.engine_getGlobalsBatch(this.__wbg_ptr, indices);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Fingerprint many globals in one boundary crossing.
     *
     * One number per index: equal numbers mean `getGlobalsBatch` would
     * return an equal value, so a host can skip reading the ones that have not
     * moved. `NaN` means "unknown, read it", which is what a value too large
     * to walk reports — the fallback is always the old always-read behaviour.
     *
     * Digests are 53-bit so they land exactly in a JS number. At that width a
     * collision across a UI's worth of state is not a practical concern, and the
     * cost of one would be a skipped update, not corruption.
     *
     * Built with the same Array and from_f64 that getGlobalsBatch uses, rather
     * than the Float64Array this obviously wants to be. A typed array pulls in
     * `__wbg_new_with_length` and `__wbg_set_index`, and the host import surface
     * is audited: check-wasm-memory.cjs pins the exact set of functions this
     * module may call out to. Widening that list to save an allocation on a
     * path that runs once per frame is a bad trade — the point of pinning it is
     * that it only moves deliberately.
     * @param {any} indices
     * @returns {any}
     */
    getGlobalsFingerprint(indices) {
        const ret = wasm.engine_getGlobalsFingerprint(this.__wbg_ptr, indices);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Compile `source` behind the preamble, run its top level, and return the
     * symbol map as `{ name: { index, scope } }`.
     *
     * Bridges should be installed first — a script's top level (and its
     * `_init`) commonly reads `localStorage` or queries `db`.
     * @param {string} source
     * @returns {any}
     */
    initScript(source) {
        const ptr0 = passStringToWasm0(source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_initScript(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    constructor() {
        const ret = wasm.engine_new();
        this.__wbg_ptr = ret;
        EngineFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Lines the preamble prepends to the host's source.
     * @returns {number}
     */
    get preambleLines() {
        const ret = wasm.engine_preambleLines(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Run pending microtasks without calling into the script.
     */
    pump() {
        const ret = wasm.engine_pump(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Restore this engine's instruction budget.
     *
     * The budget is a lifetime total, which bounds a runaway script but also
     * puts a fuse on every long-running embedder: an interactive application
     * is tens of thousands of small calls, and 50M instructions is minutes of
     * ordinary use. Call this BEFORE a re-entry and the bound becomes
     * per-re-entry instead — no single call can run unbounded, which is the
     * property a browser host actually needs, while the application lives as
     * long as its host keeps calling it.
     *
     * Host-only, and that is the whole design: this is a method on the Engine
     * binding, unreachable from guest code, so a guest still cannot raise its
     * own ceiling. Returns false once a budget has actually been spent —
     * exhaustion stays sticky and a torn-down engine stays torn down.
     * @returns {boolean}
     */
    renewInstructionBudget() {
        const ret = wasm.engine_renewInstructionBudget(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Invoke the callback the script passed to `host.call` for `call_id`.
     * @param {number} call_id
     * @param {any} result
     */
    resolveHostCallback(call_id, result) {
        const ret = wasm.engine_resolveHostCallback(this.__wbg_ptr, call_id, result);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Install the object backing `navigator.clipboard.*`. Clipboard authority
     * is intentionally separate from local storage authority.
     * @param {any} bridge
     */
    setClipboardBridge(bridge) {
        const ret = wasm.engine_setClipboardBridge(this.__wbg_ptr, bridge);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Install the object backing `db.*`. Its methods are called synchronously
     * from inside VM execution, so they must not await. Installing a bridge
     * does not grant any operation; call `setSyncHostCapabilities` separately.
     * @param {any} bridge
     */
    setDbBridge(bridge) {
        const ret = wasm.engine_setDbBridge(this.__wbg_ptr, bridge);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Key this engine's global fingerprints with host randomness.
     *
     * Supply two halves of a 64-bit value from a real random source. The
     * digest mixer is invertible, so an unkeyed digest can be SOLVED for a
     * collision — a host skipping reads on matching digests would mirror
     * stale state while the guest moved on. The key is never exposed to guest
     * code and never needs to be stable, since digests are only compared with
     * earlier digests from the same engine.
     * @param {number} lo
     * @param {number} hi
     */
    setFingerprintSeed(lo, hi) {
        wasm.engine_setFingerprintSeed(this.__wbg_ptr, lo, hi);
    }
    /**
     * Write the global in `index`. A slot currently holding a function or
     * class is left alone, so a host that reads all globals and writes them
     * back cannot destroy the script's own functions.
     * @param {number} index
     * @param {any} value
     */
    setGlobalByIndex(index, value) {
        const ret = wasm.engine_setGlobalByIndex(this.__wbg_ptr, index, value);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Write many globals in one boundary crossing.
     * @param {any} indices
     * @param {any} values
     */
    setGlobalsBatch(indices, values) {
        const ret = wasm.engine_setGlobalsBatch(this.__wbg_ptr, indices, values);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Install the object backing `localStorage.*`. This never provides the
     * clipboard bridge, even when the object happens to have clipboard-like
     * methods.
     * @param {any} bridge
     */
    setLocalStorageBridge(bridge) {
        const ret = wasm.engine_setLocalStorageBridge(this.__wbg_ptr, bridge);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Replace the exact allowlist for synchronous guest-to-host operations.
     * The list is fixed before initialization so guest execution cannot race
     * or influence a later authority upgrade. Unknown operation names reject
     * the complete update rather than being silently ignored.
     * @param {any} operations
     */
    setSyncHostCapabilities(operations) {
        const ret = wasm.engine_setSyncHostCapabilities(this.__wbg_ptr, operations);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Drain `console.log`/`info`/`debug` output produced so far.
     * @returns {any}
     */
    takeOutput() {
        const ret = wasm.engine_takeOutput(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
}
if (Symbol.dispose) Engine.prototype[Symbol.dispose] = Engine.prototype.free;

/**
 * Route Rust panics to `console.error` with a message instead of a bare
 * `unreachable` trap — without this a panic in wasm is undiagnosable.
 */
export function zipp_install_panic_hook() {
    wasm.zipp_install_panic_hook();
}

/**
 * Runs when the module is instantiated, before the host can call anything
 * else. The clock install is not optional: wasm32 has no clock, and `Vm::new`
 * reads one, so a VM constructed before this ran would trap.
 */
export function zipp_start() {
    wasm.zipp_start();
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_boolean_get_fa956cfa2d1bd751: function(arg0) {
            const v = arg0;
            const ret = typeof(v) === 'boolean' ? v : undefined;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg___wbindgen_is_function_1ff95bcc5517c252: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_null_ea9085d691f535d3: function(arg0) {
            const ret = arg0 === null;
            return ret;
        },
        __wbg___wbindgen_is_object_a27215656b807791: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_ea5e6cc2e4141dfe: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_c05833b95a3cf397: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_number_get_394265ed1e1b84ee: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_b0ca35b86a603356: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_344f42d3211c4765: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_add_c12b304936d1b8e3: function(arg0, arg1) {
            const ret = arg0.add(arg1);
            return ret;
        },
        __wbg_call_8a2dd23819f8a60a: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.call(arg1);
            return ret;
        }, arguments); },
        __wbg_call_a6e5c5dce5018821: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_call_e3b662382210db98: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.call(arg1, arg2, arg3);
            return ret;
        }, arguments); },
        __wbg_defineProperty_d680f9c4ff344910: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.defineProperty(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_delete_e226d79ca00f8589: function(arg0, arg1) {
            const ret = arg0.delete(arg1);
            return ret;
        },
        __wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_get_78f252d074a84d0b: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_7df959e12c8cb1e0: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1 >>> 0);
            return ret;
        }, arguments); },
        __wbg_has_a15cf4f0cfaaac24: function(arg0, arg1) {
            const ret = arg0.has(arg1);
            return ret;
        },
        __wbg_isArray_e91ca61593433d37: function() { return handleError(function (arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        }, arguments); },
        __wbg_keys_d43d8a53a3f9b559: function() { return handleError(function (arg0) {
            const ret = Object.keys(arg0);
            return ret;
        }, arguments); },
        __wbg_length_02c64e687322fa34: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_new_32b398fb48b6d94a: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_da52cf8fe3429cb2: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_typed_a518d1b29b7e8a7b: function() {
            const ret = new WeakSet();
            return ret;
        },
        __wbg_new_with_length_f8cbc3a5b9ff9368: function(arg0) {
            const ret = new Array(arg0 >>> 0);
            return ret;
        },
        __wbg_now_86c0d4ba3fa605b8: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_parse_1c0d8a8656d7e016: function() { return handleError(function (arg0, arg1) {
            const ret = JSON.parse(getStringFromWasm0(arg0, arg1));
            return ret;
        }, arguments); },
        __wbg_push_d2ae3af0c1217ae6: function(arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbg_set_8535240470bf2500: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_set_8a16b38e4805b298: function(arg0, arg1, arg2) {
            arg0[arg1 >>> 0] = arg2;
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_static_accessor_GLOBAL_4ef717fb391d88b7: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_8d1badc68b5a74f4: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_146583524fe1469b: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_f2829a2234d7819e: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_stringify_b54333f60f1e4dad: function() { return handleError(function (arg0) {
            const ret = JSON.stringify(arg0);
            return ret;
        }, arguments); },
        __wbindgen_cast_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./zipp_wasm_bg.js": import0,
    };
}

const EngineFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_engine_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('zipp_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
