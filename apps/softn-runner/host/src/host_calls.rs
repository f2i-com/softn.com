//! What a handler's `softn.*` calls do (the PHP host's runtime/wasm-host.mjs
//! `createWasmHost`, crypto.mjs and time.mjs), and running one handler in the
//! guest inside its request's transaction.

use std::{cell::RefCell, rc::Rc};

use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, Rng, RngCore};
use rusqlite::Connection;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::{guest::Guest, js, sql::Sql, HostError};

/// What one host call may carry: 2 MiB of arguments and a statement's 20 KB.
const MAX_CALL_BYTES: usize = 2 * 1024 * 1024 + 20_000;
/// The instruction budget of one request's engine (wasm-host.mjs `steps`).
pub const STEPS: u64 = 5_000_000;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn keyed(key: &[u8], text: &[u8]) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC takes a key of any length");
    mac.update(text);
    mac.finalize().into_bytes().into()
}

/// crypto.mjs: the operator's key, kept on this side.
pub struct Crypto {
    hmac_key: [u8; 32],
    seal_key: [u8; 32],
}

impl Crypto {
    pub fn new(key: &[u8; 32], hmac_domain: &str, seal_domain: &str) -> Self {
        Self { hmac_key: keyed(key, hmac_domain.as_bytes()), seal_key: keyed(key, seal_domain.as_bytes()) }
    }

    /// A bound or a count a script gave: a whole number, or text that spells one.
    fn whole(value: Option<&Value>) -> Option<u64> {
        let text = js::string_of(value);
        let digits = text.strip_prefix('+').unwrap_or(&text);
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let n: f64 = digits.parse().ok()?;
        (n <= js::MAX_SAFE).then_some(n as u64)
    }

    fn call(&self, op: &str, args: &[Value]) -> Result<Value, HostError> {
        let arg = |i: usize| args.get(i);
        Ok(match op {
            "sha256" => hex(&Sha256::digest(js::string_of(arg(0)).as_bytes())).into(),
            "hmac" => hex(&keyed(&self.hmac_key, js::string_of(arg(0)).as_bytes())).into(),
            "randomHex" => {
                let count = Self::whole(arg(0)).filter(|n| (1..=64).contains(n)).ok_or_else(|| HostError::own("Invalid random byte count"))?;
                let mut bytes = vec![0u8; count as usize];
                OsRng.try_fill_bytes(&mut bytes).map_err(HostError::library)?;
                hex(&bytes).into()
            }
            "randomInt" => {
                let bound = Self::whole(arg(0)).filter(|n| *n >= 1).ok_or_else(|| HostError::own("Invalid random integer bound"))?;
                OsRng.gen_range(0..bound).into()
            }
            "equal" => {
                let (a, b) = (js::string_of(arg(0)), js::string_of(arg(1)));
                (a.len() == b.len() && bool::from(a.as_bytes().ct_eq(b.as_bytes()))).into()
            }
            "seal" => {
                let mut iv = [0u8; 12];
                OsRng.try_fill_bytes(&mut iv).map_err(HostError::library)?;
                let cipher = Aes256Gcm::new_from_slice(&self.seal_key).map_err(HostError::library)?;
                let sealed = cipher.encrypt(Nonce::from_slice(&iv), js::string_of(arg(0)).as_bytes()).map_err(HostError::library)?;
                // iv | tag | ciphertext, base64, as Node's createCipheriv writes it.
                let tag_at = sealed.len() - 16;
                let mut envelope = iv.to_vec();
                envelope.extend_from_slice(&sealed[tag_at..]);
                envelope.extend_from_slice(&sealed[..tag_at]);
                STANDARD.encode(envelope).into()
            }
            _ => return Err(HostError::own(format!("Host capability denied: crypto.{op}"))),
        })
    }
}

/// The instants time.rs can put in any zone: chrono's `DateTime::<Utc>::MIN_UTC`
/// and `MAX_UTC` (years -262143 and 262142), each two days in.
const CHRONO_MIN_SECONDS: f64 = -8_334_601_228_800.0 + 172_800.0;
const CHRONO_MAX_SECONDS: f64 = 8_210_266_876_799.0 - 172_800.0;

/// time.mjs's answers, computed by the Rust host's time.rs (both are held to
/// tests/time-parity.json) and told in time.mjs's words.
fn time(op: &str, args: &[Value]) -> Result<Value, HostError> {
    use softn_runner_shared::time::dispatch;
    let arg = |i: usize| args.get(i);
    match op {
        "now" => dispatch("time.now", "", "", "").map_err(HostError::library),
        "parseZoned" => {
            let (date, time, zone) = (js::string_of(arg(0)), js::string_of(arg(1)), arg(2));
            let digits = |s: &str, shape: &str| s.len() == shape.len() && s.bytes().zip(shape.bytes()).all(|(c, p)| if p == b'9' { c.is_ascii_digit() } else { c == p });
            if !digits(&date, "9999-99-99") || !digits(&time, "99:99") {
                return Err(HostError::own("Choose a valid date and time"));
            }
            // A zone that is not text, or too long, is no zone: time.rs refuses
            // it, after the date and time, as time.mjs's order has it.
            let zone = match zone {
                Some(Value::String(z)) if z.encode_utf16().count() <= 80 => z.clone(),
                _ => String::new(),
            };
            const GAP: &str = "That local time does not exist during daylight saving. Choose another time.";
            let answer = dispatch("time.parseZoned", &date, &time, &zone).map_err(|e| {
                HostError::own(match e.as_str() {
                    "Invalid calendar date" | "Invalid local time" => "Invalid calendar date or time",
                    "Local time is ambiguous due to daylight saving" => "That local time occurs twice during daylight saving. Choose another time.",
                    "Local time does not exist due to daylight saving" => GAP,
                    _ => "Invalid time zone",
                })
            })?;
            // Years 0000 to 0999: time.mjs matches the wall clock Intl writes, and Intl
            // writes such a year unpadded, so no instant ever matches and it answers as
            // for a time the clocks skip.
            if date.as_bytes()[0] == b'0' {
                return Err(HostError::own(GAP));
            }
            Ok(answer)
        }
        "format" => {
            let seconds = js::number_of(arg(0)).floor();
            // The zone is time.mjs's first question (its formatter), the instant the next.
            let zone = match arg(1) {
                Some(Value::String(z)) if z.encode_utf16().count() <= 80 => z.clone(),
                _ => return Err(HostError::own("Invalid time zone")),
            };
            if dispatch("time.format", "0", &zone, "").is_err() {
                return Err(HostError::own("Invalid time zone"));
            }
            // A Date past JavaScript's range is a RangeError there. chrono's range, which
            // time.rs works in, ends sooner (the years past 262,000), and an instant within
            // a day of its ends cannot be put in a zone: refused like one past JavaScript's.
            if !seconds.is_finite() || (seconds * 1000.0).abs() > 8.64e15 || !(CHRONO_MIN_SECONDS..=CHRONO_MAX_SECONDS).contains(&seconds) {
                return Err(HostError::library("Invalid time value"));
            }
            dispatch("time.format", &js::number_text(seconds), &zone, "").map_err(|e| {
                if e.contains("timezone") {
                    HostError::own("Invalid time zone")
                } else {
                    HostError::library(e)
                }
            })
        }
        "age" => {
            let zone = match arg(1) {
                None | Some(Value::Null) => "UTC".to_string(),
                Some(Value::String(z)) if z.is_empty() => "UTC".to_string(),
                other => js::string_of(other),
            };
            let birth = match arg(0) {
                Some(Value::String(b)) => b.clone(),
                _ => return Ok((-1).into()),
            };
            dispatch("time.age", &birth, &zone, "").map_err(HostError::library)
        }
        _ => Err(HostError::own(format!("Host capability denied: time.{op}"))),
    }
}

/// What a script is told when a host call fails (wasm-host.mjs `scriptReason`):
/// the runner's own reason as it is, a library's only as which kind of call.
fn script_reason(op: &str, error: &HostError) -> String {
    match error {
        HostError::Own(message) => js::slice_units(&js::collapse_controls(message), 300),
        HostError::Library(_) if op == "sql.execute" => "SQL write failed".into(),
        HostError::Library(_) if op == "sql.query" || op == "sql.first" => "SQL query failed".into(),
        HostError::Library(_) => "Host call failed".into(),
    }
}

pub struct Route {
    pub handler: String,
    pub writable: bool,
}

pub struct Host {
    pub db: Rc<Connection>,
    pub sql: Rc<Sql>,
    pub crypto: Rc<Crypto>,
    pub capabilities: Vec<String>,
    pub source: String,
    pub app_config: Value,
    pub development: bool,
}

/// softn.config: the app's own settings under the two flags the host owns
/// (`{...appConfig, development, photos}`).
pub fn script_config(app_config: &Value, development: bool, photos: bool) -> String {
    // What `{...value}` makes of each kind: an object's keys, an array's and a
    // string's indices, and nothing of a number or a boolean.
    let mut map = match app_config {
        Value::Object(map) => map.clone(),
        Value::Array(items) => items.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
        Value::String(text) => text.chars().enumerate().map(|(i, c)| (i.to_string(), Value::String(c.to_string()))).collect(),
        _ => Map::new(),
    };
    map.insert("development".into(), Value::Bool(development));
    map.insert("photos".into(), Value::Bool(photos));
    js::stringify(&Value::Object(map))
}

/// What a script is told when its request's transaction ended before the
/// request did (wasm-host.mjs TRANSACTION_LOST).
const TRANSACTION_LOST: &str = "Transaction rolled back";

struct CallState {
    calls: usize,
    failure: Option<HostError>,
}

impl Host {
    /// Answer one handler's request inside a transaction: an exception, a
    /// failed host call or an invalid answer rolls it back (wasm-host.mjs
    /// `invoke`). Returns the status and the body's JSON text.
    pub fn invoke(&self, guest: &Guest, request: Value, route: &Route, photos: bool) -> (u16, String) {
        let mut transaction = false;
        let state = Rc::new(RefCell::new(CallState { calls: 0, failure: None }));
        let outcome = (|| -> Result<(u16, String), HostError> {
            self.db
                .execute_batch(if route.writable { "BEGIN IMMEDIATE" } else { "BEGIN" })
                .map_err(HostError::library)?;
            transaction = true;
            let job = serde_json::json!({
                "mode": "invoke",
                "source": self.source,
                "config": script_config(&self.app_config, self.development, photos),
                "handler": route.handler,
                "request": request,
                "steps": STEPS,
                "grant": true,
            });
            let (db, sql, crypto, capabilities, writable) = (Rc::clone(&self.db), Rc::clone(&self.sql), Rc::clone(&self.crypto), self.capabilities.clone(), route.writable);
            let calls = Rc::clone(&state);
            let answer = guest.run(&job, Box::new(move |op: &str, args_json: &str| -> String {
                // A fault in a call (a library panicking on input the script chose) is that
                // call's failure, caught here before it could cross the guest's frames.
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<Value, HostError> {
                    // The request's transaction can end under it: a statement's
                    // ON CONFLICT ROLLBACK, an error SQLite rolls back for, a
                    // write the deadline interrupted. Each statement after
                    // that would commit by itself, so none runs.
                    if db.is_autocommit() {
                        return Err(HostError::own(TRANSACTION_LOST));
                    }
                    // Past the soft deadline nothing more of the request runs:
                    // it is answered as failed before the kill.
                    if std::time::Instant::now() >= crate::soft_deadline() {
                        return Err(HostError::Library("the request ran until the deadline".into()));
                    }
                    let mut call_state = calls.borrow_mut();
                    call_state.calls += 1;
                    let args: Option<Vec<Value>> = serde_json::from_str::<Value>(&js::replace_lone_surrogates(args_json)).ok().and_then(|v| match v {
                        Value::Array(items) => Some(items),
                        _ => None,
                    });
                    let (family, name) = op.split_once('.').unwrap_or((op, ""));
                    let known = matches!(op, "sql.query" | "sql.first" | "sql.execute")
                        || matches!(op, "crypto.sha256" | "crypto.hmac" | "crypto.randomHex" | "crypto.randomInt" | "crypto.equal" | "crypto.seal")
                        || matches!(op, "time.now" | "time.parseZoned" | "time.format" | "time.age");
                    let denied = || HostError::own(format!("Host capability denied: {}", js::slice_units(op, 40)));
                    let Some(args) = args.filter(|a| call_state.calls <= 512 && known && capabilities.iter().any(|c| c == family) && a.len() <= 4) else {
                        return Err(denied());
                    };
                    if args_json.len() > MAX_CALL_BYTES {
                        return Err(HostError::own(format!("Host call arguments exceed {MAX_CALL_BYTES} bytes: {}", js::slice_units(op, 40))));
                    }
                    if !writable && op == "sql.execute" {
                        return Err(HostError::own("Read-only transaction"));
                    }
                    drop(call_state);
                    let value = match family {
                        "sql" => sql.call(&db, name, args.first(), args.get(1), writable),
                        "crypto" => crypto.call(name, &args),
                        _ => time(name, &args),
                    }?;
                    if db.is_autocommit() {
                        return Err(HostError::own(TRANSACTION_LOST));
                    }
                    Ok(value)
                }))
                .unwrap_or_else(|_| Err(HostError::Library("the host call faulted".into())));
                match result {
                    Ok(value) => js::stringify(&value),
                    // Answered, not thrown: the shim's `__softnCall` throws the
                    // reason. The request is marked failed all the same.
                    Err(error) => {
                        let reason = script_reason(op, &error);
                        calls.borrow_mut().failure.get_or_insert(error);
                        js::stringify(&serde_json::json!({ "__softnHostError": true, "message": reason }))
                    }
                }
            }))?;
            if answer.get("ok") != Some(&Value::Bool(true)) {
                return Err(HostError::Library(answer.get("error").and_then(Value::as_str).unwrap_or("the guest failed").to_string()));
            }
            let status = answer.get("status").and_then(Value::as_u64).filter(|s| (200..=599).contains(s));
            let body = answer.get("body").and_then(Value::as_str);
            // The guest's reading of the answer is checked here as well: a
            // body that is not JSON, or too large, is no answer.
            let (Some(status), Some(body), true) = (status, body, answer.get("valid") == Some(&Value::Bool(true))) else {
                return Err(HostError::Library("Invalid response".into()));
            };
            if body.len() > 3 * 1024 * 1024 || serde_json::from_str::<serde::de::IgnoredAny>(body).is_err() {
                return Err(HostError::Library("Invalid response".into()));
            }
            let rollback = answer.get("rollback") == Some(&Value::Bool(true));
            // A failed host call rolls the request back and answers host_error,
            // unless the handler asked for the rollback itself.
            if state.borrow().failure.is_some() && !rollback {
                return Err(HostError::Library("Host call failed".into()));
            }
            if !self.db.is_autocommit() {
                self.db.execute_batch(if rollback { "ROLLBACK" } else { "COMMIT" }).map_err(HostError::library)?;
            } else if !rollback {
                // Nothing it wrote is left to commit.
                return Err(HostError::own(TRANSACTION_LOST));
            }
            // A handler that asked for the rollback has it already: its answer stands.
            transaction = false;
            Ok((status as u16, body.to_string()))
        })();
        match outcome {
            Ok(answer) => answer,
            Err(error) => {
                // The first host call that failed says more than what the VM made of it.
                let failure = state.borrow_mut().failure.take();
                js::log_failure(&format!("handler {}", route.handler), failure.as_ref().unwrap_or(&error).reason());
                if transaction {
                    let _ = self.db.execute_batch("ROLLBACK");
                    (500, js::stringify(&serde_json::json!({ "error": "The request could not be completed.", "code": "host_error" })))
                } else {
                    (503, js::stringify(&serde_json::json!({ "error": "The request could not be completed.", "code": "database_busy" })))
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The last instants time.rs can put in any zone are answered, and the ones past them are
    /// refused, where chrono used to panic putting them in a zone.
    #[test]
    fn a_time_past_chronos_range_is_refused_not_a_fault() {
        for (seconds, zone) in [(CHRONO_MAX_SECONDS, "+23:59"), (CHRONO_MIN_SECONDS, "-23:59"), (CHRONO_MAX_SECONDS, "Pacific/Kiritimati")] {
            let answered = std::panic::catch_unwind(|| time("format", &[serde_json::json!(seconds), serde_json::json!(zone)]));
            assert!(matches!(answered, Ok(Ok(_))), "{seconds} {zone}: {answered:?}");
        }
        for seconds in [8_210_266_876_799.0, CHRONO_MAX_SECONDS + 1.0, CHRONO_MIN_SECONDS - 1.0, -8_334_601_228_800.0] {
            let refused = std::panic::catch_unwind(|| time("format", &[serde_json::json!(seconds), serde_json::json!("+23:59")]));
            assert!(matches!(refused, Ok(Err(HostError::Library(_)))), "{seconds}: {refused:?}");
        }
    }
}