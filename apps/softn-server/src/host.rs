//! The single channel between server-side `.logic` and the host.
//!
//! zipp exposes one hook — `__zippHostCall(kind, ...args)`, strings in and one
//! string out — so every capability the old VM implemented as a builtin opcode
//! arrives here as a `kind` string and is routed to the matching bridge.
//! `preamble.js` is the other half: the JavaScript that turns `db.query(c)`
//! into a call on this channel.
//!
//! A capability the bundle was not granted has no bridge, and the call fails
//! with a message naming it rather than answering a default. Silently returning
//! an empty result would let a script believe it had written a file.

use crate::bridges::{DbBridge, EnvBridge, FsBridge, HttpBridge, DbUpdateIf};

/// Collection of bridge instances, created per worker thread.
///
/// `None` means the bundle was not granted that capability. Kept as the same
/// struct name and field set the app and tenant loaders already build.
pub struct BridgeSet {
    pub db: Option<Box<dyn DbBridge>>,
    pub http: Option<Box<dyn HttpBridge>>,
    pub fs: Option<Box<dyn FsBridge>>,
    pub env: Option<Box<dyn EnvBridge>>,
}

/// Service one `__zippHostCall`.
///
/// `Ok` is JSON the preamble parses (or, for `fs.readFile`, the file's text —
/// the one call whose result is a raw string). `Err` becomes a catchable throw
/// inside the script carrying the host's message.
pub fn dispatch(bridges: &mut BridgeSet, kind: &str, args: &[String]) -> Result<String, String> {
    let arg = |i: usize| args.get(i).map(String::as_str).unwrap_or("");

    match kind {
        // ── db ──
        "db.query" => {
            let db = need(bridges.db.as_deref(), kind)?;
            let rows = db.query(arg(0))?;
            let json: Vec<_> = rows.iter().map(|r| r.to_json()).collect();
            enc(&serde_json::Value::Array(json))
        }
        "db.get" => {
            let db = need(bridges.db.as_deref(), kind)?;
            match db.get(arg(0), arg(1))? {
                Some(r) => enc(&r.to_json()),
                None => Ok("null".into()),
            }
        }
        "db.create" => {
            let db = need_mut(bridges.db.as_deref_mut(), kind)?;
            enc(&db.create(arg(0), arg(1))?.to_json())
        }
        "db.update" => {
            let db = need_mut(bridges.db.as_deref_mut(), kind)?;
            match db.update(arg(0), arg(1))? {
                Some(r) => enc(&r.to_json()),
                None => Ok("null".into()),
            }
        }
        "db.updateIf" => {
            let db = need_mut(bridges.db.as_deref_mut(), kind)?;
            match db.update_if(arg(0), arg(1), arg(2), arg(3))? {
                DbUpdateIf::Updated(r) => enc(&serde_json::json!({ "updated": true, "record": r.to_json() })),
                DbUpdateIf::Conflict => enc(&serde_json::json!({ "updated": false, "reason": "conflict" })),
                DbUpdateIf::Missing => enc(&serde_json::json!({ "updated": false, "reason": "missing" })),
            }
        }
        "db.delete" => {
            need_mut(bridges.db.as_deref_mut(), kind)?.delete(arg(0))?;
            Ok("null".into())
        }
        "db.hardDelete" => {
            need_mut(bridges.db.as_deref_mut(), kind)?.hard_delete(arg(0), arg(1))?;
            Ok("null".into())
        }
        "db.startSync" => {
            need_mut(bridges.db.as_deref_mut(), kind)?.start_sync(arg(0));
            Ok("null".into())
        }
        "db.stopSync" => {
            need_mut(bridges.db.as_deref_mut(), kind)?.stop_sync(opt(arg(0)));
            Ok("null".into())
        }
        "db.getSyncStatus" => {
            let s = need(bridges.db.as_deref(), kind)?.get_sync_status(opt(arg(0)));
            enc(&serde_json::json!({
                "connected": s.connected, "peers": s.peers, "room": s.room,
            }))
        }
        "db.getSavedSyncRoom" => {
            let room = need(bridges.db.as_deref(), kind)?.get_saved_sync_room();
            enc(&serde_json::json!(room))
        }

        // ── http ──
        "http.get" | "http.post" | "http.put" | "http.delete" => {
            let http = need(bridges.http.as_deref(), kind)?;
            let r = match kind {
                "http.get" => http.get(arg(0))?,
                "http.post" => http.post(arg(0), arg(1), arg(2))?,
                "http.put" => http.put(arg(0), arg(1), arg(2))?,
                _ => http.delete(arg(0))?,
            };
            enc(&serde_json::json!({ "status": r.status, "body": r.body, "ok": r.ok }))
        }

        // ── fs ──
        // The one call that answers with raw text rather than JSON: file
        // contents are handed straight back, so the preamble does not parse.
        "fs.readFile" => need(bridges.fs.as_deref(), kind)?.read_file(arg(0)),
        "fs.writeFile" => {
            need_mut(bridges.fs.as_deref_mut(), kind)?.write_file(arg(0), arg(1))?;
            Ok("null".into())
        }
        "fs.appendFile" => {
            need_mut(bridges.fs.as_deref_mut(), kind)?.append_file(arg(0), arg(1))?;
            Ok("null".into())
        }
        // `exists` answers false without the capability rather than throwing:
        // a probe for a file the script cannot reach is honestly answered "no".
        "fs.exists" => Ok(match bridges.fs.as_deref() {
            Some(fs) => fs.exists(arg(0)).to_string(),
            None => "false".into(),
        }),
        "fs.listDir" => {
            let names = need(bridges.fs.as_deref(), kind)?.list_dir(arg(0))?;
            enc(&serde_json::json!(names))
        }
        "fs.deleteFile" => {
            need_mut(bridges.fs.as_deref_mut(), kind)?.delete_file(arg(0))?;
            Ok("null".into())
        }
        "fs.mkdir" => {
            need_mut(bridges.fs.as_deref_mut(), kind)?.mkdir(arg(0))?;
            Ok("null".into())
        }

        // ── env ──
        "env.get" => enc(&serde_json::json!(need(bridges.env.as_deref(), kind)?.get(arg(0)))),
        "env.keys" => enc(&serde_json::json!(need(bridges.env.as_deref(), kind)?.keys())),
        "env.log" => {
            need(bridges.env.as_deref(), kind)?.log(arg(0), arg(1));
            Ok("null".into())
        }

        _ => Err(format!("TypeError: unknown host call '{kind}'")),
    }
}

/// `""` is how the preamble spells an omitted room; the bridges want `None`.
fn opt(s: &str) -> Option<&str> {
    if s.is_empty() { None } else { Some(s) }
}

fn need<'a, T: ?Sized>(b: Option<&'a T>, kind: &str) -> Result<&'a T, String> {
    b.ok_or_else(|| capability_denied(kind))
}

fn need_mut<'a, T: ?Sized>(b: Option<&'a mut T>, kind: &str) -> Result<&'a mut T, String> {
    b.ok_or_else(|| capability_denied(kind))
}

/// Names the capability rather than the call, because that is what the bundle
/// author has to change in `permission.json` to fix it.
fn capability_denied(kind: &str) -> String {
    let cap = kind.split('.').next().unwrap_or(kind);
    format!("Error: capability '{cap}' is not enabled for this bundle (called {kind})")
}

fn enc(v: &serde_json::Value) -> Result<String, String> {
    serde_json::to_string(v).map_err(|e| format!("Error: host reply not encodable: {e}"))
}
