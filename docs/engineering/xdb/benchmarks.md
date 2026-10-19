# Persistence and write-amplification baseline (XD-04)

Recorded 14 September 2026 on the reviewer's Windows 11 workstation (nightly Rust per `rust-toolchain.toml`, release profile, bundled SQLite via rusqlite 0.31, NVMe storage). Harness: `crates/xdb/src/bench_tests.rs`.

```sh
cargo test -p xdb --release -- --ignored --nocapture bench_persistence
XDB_BENCH_LARGE=1 cargo test -p xdb --release -- --ignored --nocapture bench_persistence   # adds 50k
```

Fixed record (~180 B JSON), fixed seeds, 50 single edits, one 100-edit batch. "rows touched" is SQLite's own change counter (`sqlite3_total_changes`) divided by the operations in the lane; "WAL bytes" is the WAL file size after the lane (checkpointed before each lane); "delta bytes" is the encoded Yrs update. These are a **baseline for the product to set a budget against**, not a target chosen by this document. Memory is left to the operator's process monitor; the harness does not claim allocator numbers.

## What the measurement found, and what changed

| Finding | Before | After | Change |
| --- | --- | --- | --- |
| Bulk import re-encoded and rewrote the **whole** CRDT document after **every** record (O(N²) bytes). 10k-record import: 34.6 s. | 34 555 ms (10k) | 94 ms (10k) | `import_records` saves the document once per collection per batch (`upsert_record_batched` / `delete_record_batched`). |
| Applying a one-record remote delta re-upserted **every** record of the collection: 10 001 rows and ~8 MB of WAL per single remote edit at 10k. A duplicate delivery did the same work again. | 10 001 rows / 8.0 MB WAL | 2 rows / 4.1 MB WAL (duplicate: 1 row) | `apply_remote_update_inner` observes the Yrs map during the transaction and upserts only the keys the update touched (`records_from_doc_keys`). A no-op delta touches no record row. |
| The batch-edit lane (100 updates in one transaction) still rewrote the whole CRDT document after **every** record: 200 rows touched and 1.15 s at 10k. | 1 149.96 ms / 200 rows (10k) | 33.52 ms / 101 rows (10k) | `update_records` (third pass): one transaction, one `crdt_state` write per touched collection, all-or-nothing, and the encoded deltas are returned for publication after commit. `update_record` is unchanged for single edits. |
| Every mutation persists the **full encoded document** (`crdt_state.doc_state`), so WAL bytes per edit scale with collection size (~165 KB at 1k... ~4.1 MB at 10k for a 426-byte delta). | unchanged | unchanged | Still the dominant remaining amplification. Next step, if the product budget needs it: append-only persistence of update deltas with periodic snapshot compaction (see "Remaining work"). |

Correctness was held fixed across the change: the transaction wrapper, consistent snapshot export, tombstones and epochs are untouched, and the regression suite (39 tests) includes duplicate remote apply, restart-after-convergence, snapshot import/export and `update_records_commits_all_or_nothing_with_one_snapshot_per_collection`.

## Baseline after the changes (sampled, 14 September 2026, third pass)

Single-operation lanes take seven independent samples (`SAMPLES`), so their p50/p95 are distributions; bulk import and the batch edit are one-shot by nature and print one value twice. Recorded on an otherwise idle machine after `update_records` landed; the batch lane's "delta bytes" is the sum of the 100 returned deltas (the earlier passes reported 0 because the lane discarded them).

### N = 1 000 records

| lane | p50 ms | p95 ms | rows touched / op | WAL bytes / op | delta bytes / op |
|---|---:|---:|---:|---:|---:|
| bulk import (N records, 1 txn) | 14.26 | 14.26 | 1001 | 824032 | 406420 |
| single edit (warm) | 3.66 | 8.74 | 2 | 85449 | 426 |
| batch edit (100 updates, 1 txn) | 7.67 | 7.67 | 101 | 770472 | 42424 |
| initial sync (peer applies full state) | 10.31 | 10.46 | 1001 | 898192 | 409861 |
| remote apply (1-record delta) | 6.27 | 6.83 | 2 | 451466 | 436 |
| duplicate remote apply (no-op delta) | 5.38 | 6.40 | 1 | 424392 | 436 |
| restart (open + read collection) | 2.00 | 2.26 | 0 | 0 | 0 |
| compaction (checkpoint + VACUUM) | 9.60 | 9.60 | 0 | 0 | 0 |

### N = 10 000 records

| lane | p50 ms | p95 ms | rows touched / op | WAL bytes / op | delta bytes / op |
|---|---:|---:|---:|---:|---:|
| bulk import (N records, 1 txn) | 102.64 | 102.64 | 10001 | 7996952 | 4072666 |
| single edit (warm) | 22.96 | 29.43 | 2 | 164636 | 426 |
| batch edit (100 updates, 1 txn) | 33.52 | 33.52 | 101 | 4569112 | 42526 |
| initial sync (peer applies full state) | 96.15 | 104.65 | 10001 | 8066403 | 4076122 |
| remote apply (1-record delta) | 28.21 | 28.68 | 2 | 4145929 | 431 |
| duplicate remote apply (no-op delta) | 18.53 | 20.17 | 1 | 4115912 | 431 |
| restart (open + read collection) | 22.81 | 23.21 | 0 | 0 | 0 |
| compaction (checkpoint + VACUUM) | 53.64 | 53.64 | 0 | 0 | 0 |

The 50 000-record lane was started under the original code and abandoned after several minutes inside the O(N²) bulk import; it has not been re-recorded here and should be run on the operator's reference hardware with `XDB_BENCH_LARGE=1` when a large-collection budget is set.

## Original measurements (before the changes, same machine)

### N = 1 000 records

| lane | p50 ms | p95 ms | rows touched / op | WAL bytes / op | delta bytes / op |
|---|---:|---:|---:|---:|---:|
| bulk import (N records, 1 txn) | 178.94 | 178.94 | 2000 | 824032 | 406300 |
| single edit (warm) | 13.41 | 38.79 | 2 | 85532 | 426 |
| batch edit (100 updates, 1 txn) | 86.21 | 86.21 | 200 | 778712 | 0 |
| initial sync (peer applies full state) | 24.07 | 24.07 | 1001 | 898192 | 409750 |
| remote apply (1-record delta) | 26.16 | 26.16 | 1001 | 836392 | 430 |
| duplicate remote apply (no-op delta) | 26.70 | 26.70 | 1001 | 836392 | 430 |
| restart (open + read collection) | 2.85 | 2.85 | 0 | 0 | 0 |
| compaction (checkpoint + VACUUM) | 35.60 | 35.60 | 0 | 0 | 0 |

### N = 10 000 records

| lane | p50 ms | p95 ms | rows touched / op | WAL bytes / op | delta bytes / op |
|---|---:|---:|---:|---:|---:|
| bulk import (N records, 1 txn) | 34555.12 | 34555.12 | 20000 | 8005192 | 4072780 |
| single edit (warm) | 97.15 | 110.46 | 2 | 164965 | 426 |
| batch edit (100 updates, 1 txn) | 1298.34 | 1298.34 | 200 | 4560872 | 0 |
| initial sync (peer applies full state) | 145.78 | 145.78 | 10001 | 8079352 | 4076269 |
| remote apply (1-record delta) | 162.87 | 162.87 | 10001 | 8029912 | 430 |
| duplicate remote apply (no-op delta) | 164.31 | 164.31 | 10001 | 8025792 | 430 |
| restart (open + read collection) | 23.53 | 23.53 | 0 | 0 | 0 |
| compaction (checkpoint + VACUUM) | 109.23 | 109.23 | 0 | 0 | 0 |

(The "rows touched" of the original bulk import counts two writes per record: the record row and the `crdt_state` row rewritten after each record.)

## Reading the numbers

- **Host-IPC overhead is not included.** These lanes call the library directly; a Tauri command adds serialization of the payload and the returned records. Measure that separately in the host when a budget is set.
- **Cold start** is the "restart" lane: opening the file and reading the collection; the CRDT document is loaded lazily on the first mutation or sync request, so a first edit after restart pays the document decode once.
- **Transport overhead** is not measured here; `delta bytes` is what a peer would receive per operation, and `initial sync` is the full-state transfer a joining peer applies.

## Remaining work (measured, not yet done)

1. **Per-edit document snapshot.** A 426-byte delta still writes the whole `doc_state` (≈ 165 KB at 1k records, ≈ 4.1 MB at 10k). Append-only persistence of update deltas into a log table with periodic snapshot compaction would make WAL bytes per edit proportional to the delta. Any such change must keep: rollback of cached CRDT state on failure, `export_to_file` consistency, tombstone retention, and the duplicate-update and restart regressions.
2. **Batch edit — done (third pass).** `Database::update_records` commits N updates in one transaction with one document save per touched collection (200 → 101 rows, 1.15 s → 34 ms at 10k). The Tauri command `update_records` (a list of `{ id, data }`) exposes it to hosts; Softn's runtime still issues one `update_record` per edit and can adopt the batch command when its callers batch.
3. **Large-collection reads.** `get_collection` returns the whole collection; consumers with large views should get pagination or indexed queries instead of repeatedly reading everything.
