//! SoftN's server-logic guest: the ZIPP engine compiled to WebAssembly.
//!
//! An app's private `.logic` is written by the app's owner, not by whoever
//! runs the server, so it runs here, inside a WebAssembly instance that
//! `softn-runner` (../host) starts under wasmtime for one job and then drops.
//! The engine is ZIPP's safe-sandbox interpreter; the wasm boundary is the
//! second wall: nothing in this instance can reach the runner's memory, the
//! database or the filesystem except through the two imports below, and the
//! runner decides every answer they give.
//!
//! It runs a job the way the PHP host's Node runner runs one in ZIPP's
//! browser engine (runtime/wasm-host.mjs): the same preamble ahead of the
//! logic (ZIPP's own, then SoftN's shim and `softn.config`), the same limits
//! (zipp-wasm's `initialize`), the same one synchronous host call (`db.query`,
//! the shim's `__softnCall`), and the handler's answer read the way
//! `engine.callFunction` and `JSON.stringify` read it there.
//!
//! ## Imports (module `softn`)
//!
//! * `ask(kind, ptr, len) -> i32`: hand the runner `len` bytes at `ptr` and
//!   get back the length of its answer, or -1. Kind 0 asks for the job
//!   (nothing is sent), 1 is a `db.query` call (the operation, a NUL, its
//!   arguments as JSON), 2 is the outcome (JSON).
//! * `take(ptr)`: copy the answer `ask` announced to `ptr`.

use zipp_vm::embed::{
    compile_script_with_preamble_and_origin, CompileOptions, HostCallError, HostValue,
    HostValueBudget, ScriptGoal, ScriptOrigin, ScriptState,
};

const ZIPP_PREAMBLE: &str = include_str!(concat!(env!("OUT_DIR"), "/zipp-preamble.js"));
const SOFTN_SHIM: &str = include_str!(concat!(env!("OUT_DIR"), "/softn-shim.js"));

#[link(wasm_import_module = "softn")]
extern "C" {
    fn ask(kind: i32, ptr: *const u8, len: usize) -> i32;
    fn take(ptr: *mut u8);
}

const ASK_JOB: i32 = 0;
const ASK_CALL: i32 = 1;
const ASK_DONE: i32 = 2;

/// One exchange with the runner.
fn exchange(kind: i32, payload: &[u8]) -> Option<Vec<u8>> {
    // SAFETY: `ask` reads `payload.len()` bytes at `payload.as_ptr()`, which is
    // this live slice, and `take` writes exactly the length `ask` returned
    // into a buffer of that length. Both are the runner's functions, bounds-
    // checked on its side against this instance's memory.
    let length = unsafe { ask(kind, payload.as_ptr(), payload.len()) };
    if length < 0 {
        return None;
    }
    let mut answer = vec![0u8; length as usize];
    if length > 0 {
        unsafe { take(answer.as_mut_ptr()) };
    }
    Some(answer)
}

// zipp-wasm's limits (lib.rs `initialize` and its constants at the tag), so a
// job stops where it stops under the Node runner.
const MAX_INITIAL_SOURCE_BYTES: usize = 16 * 1024 * 1024;
const MAX_DYNAMIC_CODE_SOURCE_BYTES: usize = 64 * 1024;
const MAX_DYNAMIC_CODE_RETAINED_SOURCE_BYTES: usize = 16 * 1024 * 1024;
const MAX_DYNAMIC_CODE_CALLS: usize = 16384;
const MAX_DYNAMIC_CODE_FUNCTIONS: usize = 16384;
const MAX_DYNAMIC_CODE_CLASSES: usize = 1024;
const MAX_APPROX_HEAP_BYTES: usize = 512 * 1024 * 1024;
const MAX_LIFETIME_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_INSTRUCTION_BUDGET_STEPS: u64 = 2_000_000_000;
const MAX_SYNC_BRIDGE_KIND_BYTES: usize = 64;
const MAX_SYNC_BRIDGE_ARGS: usize = 16;
const MAX_SYNC_BRIDGE_BYTES: usize = 32 * 1024 * 1024;

/// zipp-wasm's preamble bindings, which `callFunction` does not count among a
/// script's functions (all but the three it exposes: window, navigator, host).
const PREAMBLE_BINDINGS: &[&str] = &[
    "__zEvents", "__zHostQueue", "__zHostCbs", "__zHostPending", "__zHostId", "__zHostQueueMax",
    "__zHostPendingMax", "__zHostRequestMaxUnits", "localStorage", "db", "accel", "__zListenerTypes",
    "__zDispatchEvent", "__zPeekHostCalls", "__zCommitHostCalls", "__zRejectHostCall",
    "__zResolveHostCall", "__zCancelHostCall",
];

/// The answer that may be at most this many bytes as JSON (wasm-host.mjs).
const MAX_RESPONSE_BYTES: usize = 3 * 1024 * 1024;

/// `Date.now()`: whole milliseconds, as the browser engine's `js_sys::Date::now`
/// gives them. A fraction would be a REAL where a script stores an INTEGER.
fn epoch_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn mono_ms() -> f64 {
    static BASE: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    BASE.get_or_init(std::time::Instant::now).elapsed().as_secs_f64() * 1000.0
}

fn main() {
    // A WASI guest has the runner's clock, so `Date` is the real time.
    zipp_vm::install_clock(epoch_ms, mono_ms);
    let outcome = match exchange(ASK_JOB, &[]).and_then(|job| serde_json::from_slice::<serde_json::Value>(&job).ok()) {
        Some(job) => run(&job),
        None => failed("the runner sent no job"),
    };
    let _ = exchange(ASK_DONE, outcome.to_string().as_bytes());
}

fn failed(message: &str) -> serde_json::Value {
    serde_json::json!({ "ok": false, "error": message })
}

fn run(job: &serde_json::Value) -> serde_json::Value {
    let text = |key: &str| job.get(key).and_then(|v| v.as_str()).unwrap_or("");
    let steps = job.get("steps").and_then(|v| v.as_u64()).unwrap_or(5_000_000).clamp(1, MAX_INSTRUCTION_BUDGET_STEPS);
    let granted = job.get("grant").and_then(|v| v.as_bool()) == Some(true);
    let mut state = match compile(text("source"), text("config"), steps, granted) {
        Ok(state) => state,
        Err(e) => return failed(&e),
    };
    let result = match text("mode") {
        "validate" => validate(&mut state, job.get("handlers")),
        "invoke" => invoke(&mut state, text("handler"), job.get("request").cloned().unwrap_or(serde_json::Value::Null)),
        _ => Err("unknown job".into()),
    };
    result.unwrap_or_else(|e| failed(&e))
}

/// Compile the logic behind ZIPP's preamble, SoftN's shim and its settings, and
/// run its top level, under the browser engine's limits.
///
/// The shim and settings go in the preamble, ahead of the logic as the Node
/// runner puts them, so ZIPP reads the logic's own directive prologue: a
/// `"use strict"` makes the whole program strict, shim included, as the Node
/// runner's leading directive does. Positions count from the logic's first
/// line, under the name `logic`. (A frame inside the shim is named
/// `zipp:preamble` here, where the Node runner names it `logic`.)
fn compile(source: &str, config: &str, steps: u64, granted: bool) -> Result<ScriptState, String> {
    let preamble = format!("{ZIPP_PREAMBLE}\n{SOFTN_SHIM}\nsoftn.config={config};");
    if source.len() + SOFTN_SHIM.len() + config.len() > MAX_INITIAL_SOURCE_BYTES {
        return Err(format!("RangeError: initial script source exceeds the {MAX_INITIAL_SOURCE_BYTES}-byte limit"));
    }
    // A hashbang is honoured at the very start of a program, and in the Node
    // runner the logic never is the start (the shim is ahead of it), so there
    // `#!` is a syntax error. Here the logic is the guest text, where ZIPP
    // would honour it; it is refused as the Node runner's engine refuses it.
    if source.starts_with("#!") {
        return Err("SyntaxError: expected a private name after '#'\n    at logic:1:1".into());
    }
    let origin = ScriptOrigin { name: Some("logic".into()), ..ScriptOrigin::default() };
    let options = CompileOptions { goal: ScriptGoal::Compat };
    let mut state = compile_script_with_preamble_and_origin(&preamble, source, &options, &origin)?;
    state.set_limits(steps, None);
    state.set_dynamic_code_limits(
        MAX_DYNAMIC_CODE_SOURCE_BYTES,
        MAX_DYNAMIC_CODE_RETAINED_SOURCE_BYTES,
        MAX_DYNAMIC_CODE_CALLS,
        MAX_DYNAMIC_CODE_FUNCTIONS,
        MAX_DYNAMIC_CODE_CLASSES,
    );
    state.set_heap_limit(MAX_APPROX_HEAP_BYTES);
    state.set_output_limit(MAX_LIFETIME_OUTPUT_BYTES);
    state.disable_vm_jit();
    state.set_host_call(Box::new(move |kind, args| host_call(kind, args, granted)));
    let init = state.run_init();
    checked(&mut state, init)?;
    Ok(state)
}

const EVAL_PREFIX: &str = "JSON.stringify((function () { return (";
const EVAL_SUFFIX: &str = "); })())";

/// `engine.evalInContext(expr)` as the browser engine answers it: the
/// expression inside zipp-wasm's wrapper, its value as `JSON.stringify` text
/// (`None` for undefined), and text that is not JSON refused.
fn eval_in_context(state: &mut ScriptState, expr: &str) -> Result<Option<String>, String> {
    let wrapped = format!("{EVAL_PREFIX}{expr}{EVAL_SUFFIX}");
    let guest = EVAL_PREFIX.len()..EVAL_PREFIX.len() + expr.len();
    let result = state.eval_wrapped_in_context(&wrapped, guest);
    match checked(state, result)? {
        zipp_vm::embed::JsValue::String(text) => {
            if serde_json::from_str::<serde::de::IgnoredAny>(&text).is_err() {
                return Err("SyntaxError: evalInContext result is not valid JSON (has the guest replaced JSON.stringify?)".into());
            }
            Ok(Some(text))
        }
        _ => Ok(None),
    }
}

/// A resource ceiling the engine reached outranks whatever the call answered,
/// as in zipp-wasm's `finish_execution`.
fn checked<T>(state: &mut ScriptState, result: Result<T, String>) -> Result<T, String> {
    if let Some(error) = state.resource_limit_error() {
        return Err(error.to_string());
    }
    result
}

/// `__zippHostCall`, as zipp-wasm's `host_dispatch` answers it for an engine
/// whose one grant is `db.query` (the Node runner's), or none (its validation).
fn host_call(kind: &str, args: &[String], granted: bool) -> Result<String, String> {
    let arity = match kind {
        "db.query" | "db.get" | "db.create" | "db.update" | "db.hardDelete" | "ls.setItem" => Some(2),
        "db.delete" | "db.startSync" | "db.stopSync" | "db.getSyncStatus" | "ls.getItem" | "ls.removeItem"
        | "nav.clipboardWrite" => Some(1),
        "db.getSavedSyncRoom" | "ls.clear" | "nav.clipboardRead" => Some(0),
        "accel.compile" | "accel.make" | "accel.run" | "accel.install" => Some(2),
        "accel.state" => Some(1),
        _ if is_app_host_call(kind) => None,
        _ => return Err(format!("TypeError: unknown host call '{kind}'")),
    };
    if args.len() > MAX_SYNC_BRIDGE_ARGS {
        return Err(format!("RangeError: host bridge call exceeds the {MAX_SYNC_BRIDGE_ARGS}-argument limit"));
    }
    let bytes = args.iter().try_fold(kind.len(), |total, arg| total.checked_add(arg.len()).filter(|n| *n <= MAX_SYNC_BRIDGE_BYTES));
    if bytes.is_none() {
        return Err(format!("RangeError: host bridge arguments exceed the {MAX_SYNC_BRIDGE_BYTES}-byte limit"));
    }
    if let Some(arity) = arity {
        if args.len() != arity {
            return Err(format!("TypeError: host bridge call '{kind}' requires exactly {arity} arguments"));
        }
    }
    if kind != "db.query" || !granted {
        return Err("SecurityError: synchronous host capability denied".into());
    }
    if serde_json::from_str::<serde::de::IgnoredAny>(&args[1]).is_err() {
        return Err("TypeError: malformed JSON in host bridge argument".into());
    }
    let mut payload = Vec::with_capacity(args[0].len() + 1 + args[1].len());
    payload.extend_from_slice(args[0].as_bytes());
    payload.push(0);
    payload.extend_from_slice(args[1].as_bytes());
    let answer = exchange(ASK_CALL, &payload).ok_or_else(|| "Error: host bridge call failed".to_string())?;
    if answer.len() > MAX_SYNC_BRIDGE_BYTES {
        return Err(format!("RangeError: host bridge reply exceeds the {MAX_SYNC_BRIDGE_BYTES}-byte limit"));
    }
    String::from_utf8(answer).map_err(|_| "Error: host bridge call failed".to_string())
}

/// zipp-wasm's `is_app_host_call`: the shape of an `app.<kind>` name.
fn is_app_host_call(kind: &str) -> bool {
    let Some(rest) = kind.strip_prefix("app.") else { return false };
    let bytes = rest.as_bytes();
    !bytes.is_empty()
        && kind.len() <= MAX_SYNC_BRIDGE_KIND_BYTES
        && bytes[0].is_ascii_lowercase()
        && bytes[bytes.len() - 1] != b'.'
        && !rest.contains("..")
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-'))
}

fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c == '$' || c == '_' || c.is_ascii_alphabetic())
        && chars.all(|c| c == '$' || c == '_' || c.is_ascii_alphanumeric())
}

/// Every declared route's handler is a function of the logic
/// (wasm-host.mjs `validateWasmSource`).
fn validate(state: &mut ScriptState, handlers: Option<&serde_json::Value>) -> Result<serde_json::Value, String> {
    let empty = Vec::new();
    for handler in handlers.and_then(|h| h.as_array()).unwrap_or(&empty) {
        let name = handler.as_str().unwrap_or("");
        if !is_identifier(name) {
            return Err("Missing route handler".into());
        }
        if eval_in_context(state, &format!("typeof {name} === \"function\""))?.as_deref() != Some("true") {
            return Err("Missing route handler".into());
        }
    }
    Ok(serde_json::json!({ "ok": true }))
}

/// Run `onStart` if the logic has one, then call the route's handler with the
/// request (wasm-host.mjs `invoke`), and read its answer as the Node runner
/// reads `engine.callFunction`'s.
fn invoke(state: &mut ScriptState, handler: &str, request: serde_json::Value) -> Result<serde_json::Value, String> {
    eval_in_context(state, "typeof onStart === \"function\" ? onStart() : null")?;
    let slot = state
        .symbols()
        .into_iter()
        .find(|s| s.name == handler && !PREAMBLE_BINDINGS.contains(&s.name.as_str()))
        .map(|s| s.index)
        .ok_or_else(|| format!("zipp: no such function '{handler}'"))?;
    // Depth 1: the request is the first entry of the argument list.
    let argument = json_to_host(request, 1);
    let mut budget = HostValueBudget::default();
    let called = state.call_slot_bounded(slot, &[argument], &mut budget).map_err(|e| match e {
        HostCallError::Conversion(message) | HostCallError::Thrown(message) => message,
    });
    let result = checked(state, called)?;

    // `!result || !Number.isInteger(result.status) || status outside
    // 200-599 || !Object.hasOwn(result, 'body') || JSON.stringify(result)
    // over 3 MiB` is an invalid response (wasm-host.mjs).
    let pairs = match &result {
        HostValue::Object(pairs) => Some(pairs),
        _ => None,
    };
    let field = |name: &str| pairs.and_then(|p| p.iter().rev().find(|(k, _)| k == name).map(|(_, v)| v));
    let status = match field("status") {
        Some(HostValue::Number(n)) if n.is_finite() && n.fract() == 0.0 && (200.0..=599.0).contains(n) => Some(*n as u16),
        _ => None,
    };
    let body = field("body");
    let whole = stringify(&result).map_or(0, |text| text.len());
    let valid = status.is_some() && body.is_some() && whole <= MAX_RESPONSE_BYTES;
    let rollback = field("rollback").is_some_and(truthy);
    let body = body.and_then(stringify).unwrap_or_else(|| "null".into());
    Ok(serde_json::json!({ "ok": true, "valid": valid, "status": status, "rollback": rollback, "body": if valid { Some(body) } else { None } }))
}

/// JavaScript's `ToBoolean` of what `callFunction` hands the Node runner.
fn truthy(value: &HostValue) -> bool {
    match value {
        HostValue::Undefined | HostValue::Null | HostValue::Opaque => false,
        HostValue::Bool(b) => *b,
        HostValue::Number(n) => *n != 0.0 && !n.is_nan(),
        HostValue::String(s) => !s.is_empty(),
        HostValue::Utf16(units) => !units.is_empty(),
        HostValue::Array(_) | HostValue::Object(_) | HostValue::Float32Array(_) => true,
    }
}

// ── The request, into the VM ──

/// How deep `callFunction` reads its arguments (zipp-wasm `from_js`, whose
/// depth 0 is the argument list itself): an object or array this deep or
/// deeper reaches the handler as null.
const MAX_ARGUMENT_DEPTH: usize = 64;

/// A JSON value as `JSON.parse` would make it and `callFunction` would read
/// it, at `depth` in its argument list: an object's integer-like keys first,
/// in ascending order, then the rest in the order written.
fn json_to_host(value: serde_json::Value, depth: usize) -> HostValue {
    match value {
        serde_json::Value::Null => HostValue::Null,
        serde_json::Value::Bool(b) => HostValue::Bool(b),
        serde_json::Value::Number(n) => HostValue::Number(n.as_f64().unwrap_or(f64::NAN)),
        serde_json::Value::String(s) => HostValue::String(s),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) if depth >= MAX_ARGUMENT_DEPTH => HostValue::Null,
        serde_json::Value::Array(items) => HostValue::Array(items.into_iter().map(|v| json_to_host(v, depth + 1)).collect()),
        serde_json::Value::Object(map) => {
            let mut pairs: Vec<(String, HostValue)> = map.into_iter().map(|(k, v)| (k, json_to_host(v, depth + 1))).collect();
            pairs.sort_by_key(|(k, _)| array_index(k).map_or((1, 0), |i| (0, i)));
            HostValue::Object(pairs)
        }
    }
}

/// The index an array-index key names (a canonical whole number below
/// 2^32 - 1), which JavaScript orders ahead of an object's other keys.
fn array_index(key: &str) -> Option<u64> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 || !bytes.iter().all(u8::is_ascii_digit) || (bytes[0] == b'0' && bytes.len() > 1) {
        return None;
    }
    key.parse::<u64>().ok().filter(|i| *i < 4_294_967_295)
}

// ── The answer, out of the VM ──

/// `JSON.stringify` of the value `callFunction` would hand the Node runner for
/// `value` (zipp-wasm `to_js`): `None` for `undefined`, as `JSON.stringify`
/// answers it. A function, Map, Date or other value that cannot cross is
/// `null` there, and so here.
fn stringify(value: &HostValue) -> Option<String> {
    let mut out = String::new();
    write_json(value, &mut out).then_some(out)
}

fn write_json(value: &HostValue, out: &mut String) -> bool {
    match value {
        HostValue::Undefined => return false,
        HostValue::Null | HostValue::Opaque => out.push_str("null"),
        HostValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        HostValue::Number(n) => write_number(*n, out),
        HostValue::String(s) => write_string(s, out),
        HostValue::Utf16(units) => write_utf16(units, out),
        // A typed array is an object of its indices to `JSON.stringify`.
        HostValue::Float32Array(values) => {
            out.push('{');
            for (i, v) in values.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push('"');
                out.push_str(&i.to_string());
                out.push_str("\":");
                write_number(f64::from(*v), out);
            }
            out.push('}');
        }
        HostValue::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                if !write_json(item, out) {
                    out.push_str("null");
                }
            }
            out.push(']');
        }
        HostValue::Object(pairs) => {
            let mut order: Vec<&(String, HostValue)> = pairs.iter().collect();
            order.sort_by_key(|(k, _)| array_index(k).map_or((1, 0), |i| (0, i)));
            out.push('{');
            let mut first = true;
            for (key, item) in order {
                if matches!(item, HostValue::Undefined) {
                    continue;
                }
                if !first {
                    out.push(',');
                }
                first = false;
                write_string(key, out);
                out.push(':');
                write_json(item, out);
            }
            out.push('}');
        }
    }
    true
}

/// A number as JavaScript writes it (Number::toString), `null` when it is not
/// finite, as `JSON.stringify` writes it.
fn write_number(n: f64, out: &mut String) {
    if !n.is_finite() {
        out.push_str("null");
        return;
    }
    if n == 0.0 {
        out.push('0');
        return;
    }
    if n < 0.0 {
        out.push('-');
    }
    // The shortest digits that read back as `n` (ryu), then JavaScript's layout.
    let mut buffer = ryu::Buffer::new();
    let text = buffer.format_finite(n.abs());
    let (mantissa, exponent) = match text.find(['e', 'E']) {
        Some(i) => (&text[..i], text[i + 1..].parse::<i32>().unwrap_or(0)),
        None => (text, 0),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let joined = format!("{whole}{fraction}");
    let leading = joined.len() - joined.trim_start_matches('0').len();
    let digits = joined[leading..].trim_end_matches('0');
    let k = digits.len() as i32;
    let point = whole.len() as i32 + exponent - leading as i32;
    if k <= point && point <= 21 {
        out.push_str(digits);
        out.extend(std::iter::repeat_n('0', (point - k) as usize));
    } else if 0 < point && point <= 21 {
        out.push_str(&digits[..point as usize]);
        out.push('.');
        out.push_str(&digits[point as usize..]);
    } else if -6 < point && point <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-point) as usize));
        out.push_str(digits);
    } else {
        let e = point - 1;
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if e < 0 { '-' } else { '+' });
        out.push_str(&e.unsigned_abs().to_string());
    }
}

fn write_char(c: char, out: &mut String) {
    match c {
        '"' => out.push_str("\\\""),
        '\\' => out.push_str("\\\\"),
        '\u{8}' => out.push_str("\\b"),
        '\u{c}' => out.push_str("\\f"),
        '\n' => out.push_str("\\n"),
        '\r' => out.push_str("\\r"),
        '\t' => out.push_str("\\t"),
        c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
        c => out.push(c),
    }
}

fn write_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        write_char(c, out);
    }
    out.push('"');
}

/// A string with a lone surrogate: well-formed `JSON.stringify` writes the
/// surrogate as a `\u` escape.
fn write_utf16(units: &[u16], out: &mut String) {
    out.push('"');
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok(c) => write_char(c, out),
            Err(lone) => out.push_str(&format!("\\u{:04x}", lone.unpaired_surrogate())),
        }
    }
    out.push('"');
}
