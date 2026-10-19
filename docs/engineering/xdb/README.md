# XDB, the native database crate

`crates/softn-xdb` stores an app's JSON records in named collections in
SQLite, keeps a Yrs (CRDT) document per collection for its native peer
protocol, and can export and restore a database. SoftN's desktop runtime and
its Rust server are built on it. It was a separate repository until 19
October 2026, when it was imported here (the commit that added
`crates/softn-xdb` names the source revision), and it lives only here now.

The package is `softn-xdb` and is not published; the library is still called
`xdb`, so the code that uses it writes `use xdb::...`. The names other
programs see are unchanged and must stay so: the Tauri command and event
names below, the `.xdb` files in a bundle, and the runtime's `getXDB` and
`SoftNWithXDB` that existing bundles and FormLogic use.

Also here: the [networking and restore policy](networking-and-restore-policy.md)
(the contract the desktop runtime relies on), the
[persistence benchmarks](benchmarks.md) and the dated
[September 2026 review](audit-2026-09-12.md).

## Where it is used

| Consumer | What it uses |
| --- | --- |
| Desktop runtime (`apps/softn-loader`) | The crate with its default feature, `tauri-commands`: Tauri commands persist each app's records in SQLite. |
| Rust server (`apps/softn-host-rust`) | The crate without Tauri (`default-features = false`). It backs the server's collection API, the `.logic` database bridge and synchronized records; a sync push is one `with_batch`. |
| Browser runtime, Studio and Builder | Not this crate: SoftN's own TypeScript service (`packages/@softn/core/src/runtime/xdb.ts`). Browser apps use local storage, and editors keep preview data apart from the running app. In the desktop runtime the same service calls this crate's commands. |

Both apps take it by path:

```toml
# apps/softn-loader/src-tauri/Cargo.toml
xdb = { package = "softn-xdb", path = "../../../crates/softn-xdb" }
# apps/softn-host-rust/Cargo.toml
xdb = { package = "softn-xdb", path = "../../crates/softn-xdb", default-features = false }
```

## Three synchronization paths

- **Native XDB peer sync (experimental, opt-in):** libp2p, mDNS discovery,
  GossipSub messages and Yrs documents. It is off by default: opening a
  database never starts it; a host enables it explicitly
  (`set_network_enabled`, which the desktop runtime puts behind a question)
  and the choice is persisted. The wire protocol carries the default
  database only and is a trusted-LAN development feature. See the
  [policy](networking-and-restore-policy.md).
- **SoftN browser peer sync:** SoftN's separate Yjs + WebRTC implementation,
  joined explicitly by app and room.
- **SoftN server sync:** SoftN's WebSocket client and the Rust server.
  FormLogic's hosted actions use a separate authenticated backend bridge.

These are separate transports. Running a SoftN app in the browser does not
start this crate's libp2p network or make it a native XDB peer.

Native writes stay saved locally while offline. There is no delivery queue:
convergence comes from retained CRDT state plus anti-entropy. On every new
peer connection a node announces its collections and asks to reconcile each
of them (unknown ones included), and a bounded repair pass repeats that
every 30 s while peers are connected. `get_network_status` reports what
happened (publishes that reached a peer and those that did not, updates
applied and rejected, the last reconcile) rather than one "synced" flag.

## Data model

A record has `id`, `collection`, `data`, `created_at`, `updated_at` and
`deleted`. New records get UUIDs. A collection exists once a record is
written to it.

- `update_record` merges object fields shallowly; a payload that is not an
  object replaces `data`.
- `delete_record` writes a tombstone. `get_collection` hides deleted
  records; the lower-level `get_record` can return a tombstone.
- `clear_collection` is a LOCAL hard reset, not a replicated deletion: peers
  repopulate this node on the next reconciliation. A replicated deletion is
  a tombstone (`delete_record`, or `import_records` with `replace`). An
  authoritative reset of a shared collection is `reset_collection` with
  scope `replicated`: it advances the collection's reset epoch, which every
  sync message carries; peers adopt the reset, and updates from peers still
  on the old epoch are rejected.
- `import_database` takes a `scope`: `local` (this node only; sync pauses
  until `resume_sync`), `fork` (a new isolated namespace whose directory is
  reserved atomically) or `replace` (this data becomes authoritative for
  peers through reset epochs, activated together with the data in one step).
  The pending-restore record is a recovery journal (phase, backup, source,
  plan) written before anything is replaced.
- `resume_sync` refuses an unreadable record or a restore interrupted before
  it was applied; `recover_restore` (`action`: `rollback` | `complete` |
  `discard`) resolves those explicitly. While paused, no inbound update,
  reset or request is applied or answered and no reconciliation runs.
- `import_records` imports several collections in one transaction and
  returns its summary only after the commit.
- Tombstones and epochs are kept indefinitely; there is no compaction that
  could make a rejoining peer diverge silently.
- `with_transaction` groups SQLite and CRDT changes. Publish the deltas it
  returns only after the containing transaction succeeds.
- `with_batch` is `with_transaction` for many record writes: each
  collection's CRDT document is saved once, before the transaction commits,
  instead of at every write. A record write saves a document as large as its
  collection, so a host applying N pushed operations one by one would pay
  for the collection N times. A write that fails inside the batch and is
  caught still rolls back alone, and the writes around it are in the
  document that is saved.
- Nested transactions use savepoints. A failed operation rolls back its
  SQLite writes and its cached CRDT state, also when the caller catches an
  inner error.
- Each CRDT map entry holds one serialized record. Concurrent changes to
  **different records** merge; concurrent edits to the **same record**
  resolve to one whole record. This is not field-by-field collaborative
  editing.
- A `.xdb` file inside a SoftN bundle is a JSON schema and seed document. It
  is not a SQLite database and not an XDB backup.

Exports are SQLite snapshots and include committed writes still in the WAL.
Imports check the database structure, the record JSON and the saved CRDT
documents before replacing anything. The reported size is the logical
snapshot's, WAL pages included.

## The Rust API

Opening `XdbDatabase` or calling `create_shared_db` does not start
networking. Without the `tauri-commands` feature the networking types are
still there for a host that creates a node itself.

```rust
use std::path::PathBuf;
use xdb::{create_shared_db, DbResult};

fn save_notes() -> DbResult<()> {
    let shared = create_shared_db(PathBuf::from("notes.sqlite"))?;
    let mut db = shared.lock().expect("database lock poisoned");

    db.with_transaction(|db| {
        db.create_record("notes", serde_json::json!({ "title": "First note" }))?;
        db.create_record("notes", serde_json::json!({ "title": "Second note" }))?;
        Ok(())
    })?;

    let notes = db.get_collection("notes")?;
    println!("{} saved notes", notes.len());
    Ok(())
}
```

| Method | Purpose |
| --- | --- |
| `create_record`, `update_record`, `delete_record`, `upsert_record` | Write a record and return its CRDT update. |
| `get_record`, `get_collection`, `get_collections` | Read persisted records and collection names. |
| `with_transaction` | Run a group of operations in one transaction. |
| `with_batch` | The same, saving each touched collection's CRDT document once at the end. |
| `get_full_state`, `get_state_vector`, `get_updates_since`, `apply_remote_update` | Integrate a host's own sync transport. |
| `export_to_file`, `replace_from_file` | Export and restore the SQLite storage. |
| `plan_authoritative_restore`, `apply_authoritative_restore`, `replace_from_file_authoritative` | Compute the reset plan without touching the live database, then activate snapshot and epochs in one step (R3-XD-02). |
| `clear_collection`, `get_stats` | Reset a collection locally, or read database statistics. |
| `import_records` | Import several collections in ONE transaction; the summary comes after the commit (SN-01). |
| `update_records` | Update several records in ONE transaction with one CRDT snapshot per touched collection; all or nothing (XD-04). |
| `reset_collection`, `bump_epoch`, `get_epoch`, `apply_remote_reset`, `apply_remote_update_at_epoch` | Reset epochs, for replicated resets and refusing stale peers (XD-03). |
| `reconcile_plan`, `unknown_collections` | Inputs for join and repair reconciliation (XD-02). |

## The Tauri side (`tauri-commands`)

`xdb::tauri::setup_xdb(app)` opens the databases during Tauri setup and
starts networking only if it was enabled before; the host registers the
commands it uses with `tauri::generate_handler!` (the desktop runtime's
list is in `apps/softn-loader/src-tauri/src/lib.rs`).

The default database is `<app data>/apps/_default/data.sqlite`; a named app's
is `<app data>/apps/<sanitized app ID>/data.sqlite`, and an empty or missing
ID means `_default`. `setup_xdb_with_path` puts the default database at the
given path and the named ones beneath its parent directory. Sanitized names
are a storage namespace, not authentication. Only the default database takes
part in native peer sync; a named app's writes stay local, and
`request_sync` says native sync is unavailable for that scope.

Commands take an optional `appId` (the Rust parameter is `app_id`):

- CRUD: `create_record`, `update_record`, `delete_record`, `upsert_record`;
  `update_records` batches updates in one transaction.
- Reads: `get_record`, `get_collection`, `get_collections`, `get_db_stats`,
  `get_db_path`, `get_db_base_dir`.
- Maintenance: `clear_collection` (local), `reset_collection` (`scope`:
  `local` | `replicated`), `import_records`, `export_database`,
  `import_database` (`scope`: `local` | `fork` | `replace`).
- Sync (default database only): `request_sync`, `reconcile_network`,
  `resume_sync`, `recover_restore` (`action`: `rollback` | `complete` |
  `discard`).
- Networking policy: `get_network_settings`, `set_network_enabled`
  (persisted opt-in; local-only by default), `get_network_status` (`mode`,
  `enabled`, `discovery`, `listening`, `is_running`, `sync_paused`, `stats`;
  see the policy).

| Event | Payload and scope |
| --- | --- |
| `xdb-data-event` | A local change: `{ type, app_id, collection? }`. Types are `create`, `update`, `delete`, `upsert`, `clear` and `import`; `import` has no collection, so the whole database is read again. |
| `xdb-sync-event` | A peer's update: `{ type, collection }`, default database only. |
| `xdb-peer-event` | A peer's connection status: `{ type, peer_id, addresses? }`. |
| `db-imported` | A restore finished: `{ app_id }`. |

An event's `app_id` is the canonical sanitized ID, `_default` for the
default database.

## Checks

From the repository root (CI runs the first, and checks the desktop runtime,
which compiles the Tauri commands):

```sh
cargo test --locked --no-default-features --manifest-path crates/softn-xdb/Cargo.toml
# with the Tauri commands' own tests; needs the platform's Tauri build dependencies
cargo test --locked --manifest-path crates/softn-xdb/Cargo.toml
cargo clippy --manifest-path crates/softn-xdb/Cargo.toml --all-targets
# persistence / write-amplification baseline (benchmarks.md)
cargo test --manifest-path crates/softn-xdb/Cargo.toml --release -- --ignored --nocapture bench_persistence
```

The crate has its own `Cargo.lock` for these runs; the loader and the Rust
server resolve it again in theirs (see
[dependency maintenance](../dependency-maintenance.md)).

One more test drives two real network nodes over loopback sockets in one
process: mDNS discovery, GossipSub delivery, a partition with writes on both
sides, a restart under a new peer identity, automatic reconciliation and live
delivery afterwards. It needs multicast on the host and takes about 35
seconds, so it is ignored by default:

```sh
cargo test --manifest-path crates/softn-xdb/Cargo.toml -- --ignored two_nodes --nocapture
```

On Windows the multicast route decides which interface discovery packets
leave by; a virtual adapter with a better metric than the real card (WSL's
Hyper-V adapter, for one) hides the two nodes from each other and the test
fails at discovery. A Linux container does not have that problem. The
`lan-probe` binary (`src/bin/lan-probe.rs`) is one node as a process: it
writes one record and waits until it also holds its peer's, for runs across
two network namespaces or two hosts.

Discovery asks the LAN again every 30 s (`MDNS_QUERY_INTERVAL`) instead of
libp2p's five-minute default, so two nodes that start at the same instant,
or a peer that restarts, find each other within a minute.

A run across two real machines is still a manual check: enable networking in
both desktop runtimes (it is off by default), on a trusted network, and check
that creates, updates and deletes in the default database reach the other
side; then disconnect one, edit on both, reconnect and confirm they converge
without pressing sync.

## Layout

```text
crates/softn-xdb/
  src/db.rs          SQLite storage, transactions and Yrs documents
  src/network.rs     native libp2p discovery and synchronization
  src/tauri.rs       app database manager, commands and events (tauri-commands)
  src/*_tests.rs     the test suites; bench_tests.rs is the benchmark harness
  src/bin/lan-probe.rs
  build.rs           embeds windows-test.manifest so that, with tauri-commands,
                     the crate's own Windows tests can load TaskDialogIndirect
  LICENSE            MIT, the crate's licence before it moved here
```
