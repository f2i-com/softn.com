# Native networking, reconciliation and restore policy

**Status:** implemented in the `xdb` crate on 14 September 2026 for the ecosystem review tickets XD-01, XD-02 and XD-03, plus the bulk import required by SN-01; the same day's recheck tickets R2-XD-01 to R2-XD-04 are folded in below. This document is the contract hosts (Softn's native loader, the demo) rely on. Where a guarantee is *not* provided, it says so.

## 1. Networking is opt-in (XD-01)

- Opening a database (`XdbDatabase::open`, `create_shared_db`, `setup_xdb`) never starts discovery, listening or synchronization. The default mode is **local-only**.
- The choice is persisted in `<app data>/network-settings.json` as `NetworkSettings { enabled, discovery, listen }`. A missing or unreadable file means local-only. Only `set_network_enabled` (an explicit user/admin action) writes it.
- `get_network_status` reports `mode` (`local-only` | `trusted-lan`), `enabled`, `discovery`, `listening`, `is_running`, `sync_paused` and the `stats` counters separately. Nothing is inferred from a connection count.
- Disabling networking (`set_network_enabled(false)`) shuts the node down: listeners and mDNS stop, the command channel closes, local persistence is untouched. Enabling starts a fresh node with a fresh transport key.
- The v1 protocol remains a **trusted-LAN development feature**: one GossipSub topic, one default namespace, mDNS discovery, transport-key signatures with the claimed sender checked against the signer. That is transport identity, not application or user authorization. Do not enable it outside an explicitly trusted network.
- Namespace routing is deny-by-default: named apps (`app_id` other than the default) never enter the protocol (`supports_legacy_sync`), for updates, requests, resets and imports alike. Attaching an `app_id` to the shared topic would not be isolation and is not done.

### Not provided yet (still experimental)

- Peer membership authentication, per-namespace authorization, key rotation and revocation. A successor protocol must bind every operation to an authorized application/account namespace before unattended sharing is offered. Until then the feature is labelled trusted-LAN development only, and the host must present it that way.

## 2. Reconciliation and honest status (XD-02)

Durability mechanism: **retained CRDT state plus guaranteed anti-entropy**. Every collection's full Yrs document is persisted in SQLite (`crdt_state`), so nothing has to be queued to survive a partition or a restart. There is deliberately **no durable outbox**: XDB does not promise message or event delivery, only state convergence.

- On every new peer connection the node publishes `PeerAnnounce` (its collection names, bounded to 200) and a `SyncRequest` (state vector + epoch) for each local collection.
- On receiving `PeerAnnounce`, a node requests every announced collection, including ones it has never stored — those are requested with an empty state vector, so a collection created on only one side is discovered and transferred.
- A bounded repair pass runs every 30 s (plus a per-node jitter under 5 s) while at least one peer is connected: it re-announces and requests a round-robin window of 25 local collections per tick.
- `reconcile_network` triggers the same pass on demand.
- Repeated deliveries and interrupted passes are idempotent: Yrs updates are commutative and idempotent, and the regression test `disconnected_peers_converge_after_reconnecting_without_manual_intervention` covers disjoint offline edits, a one-sided collection, independent restarts, duplicate deliveries and a restart after convergence.

Status semantics (`SyncStats`):

| Counter | Means | Does NOT mean |
| --- | --- | --- |
| `publishes_sent` | GossipSub accepted the message with at least one subscribed peer. | A peer applied or persisted it. |
| `publishes_without_peers` | No subscribed peer; the local commit is safe, delivery will come from the next announce/repair. | Data loss. |
| `updates_applied` / `sync_responses_applied` | This node applied an inbound update. | The sender knows that. |
| `updates_rejected_stale` | Inbound update carried an older reset epoch and was refused. | An error on the sender's side; it will adopt the reset. |
| `updates_skipped_paused` | Held while a local restore is unresolved. | Lost; the repair pass fetches them after `resume_sync`. |
| `last_announce_at` / `last_repair_at` / `last_update_applied_at` | Timestamps of what happened. | A convergence guarantee. |

Conflict semantics are unchanged and deliberate: concurrent changes to **different records** merge; concurrent edits to the **same record** resolve to one whole record (last write by Yrs ordering). This is not field-level merging and hosts must not promise it.

## 3. Local reset, replicated deletion and administrative reset (XD-03)

Four distinct operations:

| Operation | Command / method | Scope | Replicated? |
| --- | --- | --- | --- |
| Local cache reset | `clear_collection` (`reset_collection` scope `local`) | this node only | No — peers repopulate this node on the next reconciliation. |
| Replicated record deletion | `delete_record` | shared | Yes, as a tombstone that travels like any update. |
| Replace-style import of records | `import_records` with `replace: true` | shared | Yes — absent records become tombstones, never hard deletes. |
| Administrative reset of a shared collection | `reset_collection` scope `replicated` (`XdbDatabase::reset_collection`) | shared | Yes, through a **reset epoch**. |

Reset epochs:

- Each collection has an epoch (0 until first reset), stored in `collection_epochs` and carried on every `SyncUpdate`, `SyncRequest` and `SyncResponse` (`epoch`, default 0 for older peers).
- A replicated reset clears the origin's records and CRDT state, increments the epoch and broadcasts `CollectionReset { epoch }`. A receiver with an older epoch clears its copy, adopts the epoch, and immediately requests the post-reset state. An equal or older reset does nothing.
- An inbound update whose epoch is **behind** the local epoch is rejected (`RemoteApplyOutcome::StaleEpoch`): a peer that was offline during the reset cannot silently reverse it. An update whose epoch is **ahead** makes the receiver adopt the reset first (`MissingReset`), then apply.
- A `SyncRequest` from a peer on an older epoch is answered with the reset followed by the whole post-reset state; a request from a peer on a newer epoch makes this node ask that peer instead.

Pending restore record (R2-XD-01): for the synchronized default database, `import_database` writes `<app data>/pending-restore.json` and pauses the gate **before** any byte is replaced, whether or not a network node is running. `NetworkControl` loads that record at startup and starts paused, before any network node can exist; `set_network_enabled` shares the same gate, so enabling networking after an offline restore never accepts a merge implicitly. Only `resume_sync` (an explicit, durable resolution) removes the record and lifts the pause. A `replace` restore stays pending until its committed reset plan has been published (immediately when networking is on, otherwise by `resume_sync` or `recover_restore complete` once it is). One rule, `NetworkControl::publication_precondition`, decides that for the initial import, `resume_sync` and every `recover_restore` step (R4-XD-01): an applied `replace` restore with **no running network node** is refused with the fix named (enable networking, then resume), the record keeps its plan, the pause holds, and a restart finds the same plan; a `local` restore carries no plan and its explicit resume needs no node. Publication hands the plan to GossipSub and is not proof of peer adoption. A restore that fails mid-way keeps the record and the pre-restore backup.

What the pause means (R3-XD-01): one policy, `SyncGate::permits(SyncActivity)`, decides every activity of the event loop while a restore is unresolved. Paused, the node applies **no** inbound update or sync response, adopts **no** inbound reset, answers **no** sync request, and neither announces nor requests collections (join, repair tick, reconnect, the `Reconcile` command and a peer's announce are all skipped); locally committed updates are not published either (`updates_skipped_paused` counts every held item). Connection bookkeeping (mDNS, connect/disconnect) continues, so peers stay reachable. The one data-bearing message allowed out is `CollectionReset` for a committed plan, because publishing it *is* the resolution of a `replace` restore. Each check is made again under the database lock: a pause established while an update or reset was waiting for the lock wins, because the pause and the replacement are decided under the same mutex.

Only a confirmed absent record file means "no pending restore". A file that exists but cannot be read (permissions, a directory in its place, an I/O error) or parsed is loaded as pending with `unreadable: <reason>` (visible in `get_network_status.pending_restore`), holds the gate, refuses `resume_sync`, and can only be acknowledged with `recover_restore { action: "discard" }` once the operator has settled what it recorded.

Recovery journal (R3-XD-02): the record is written **before** the live database is touched and carries `phase`, `backup_path`, `source_path`, `prior_catalog` (the live catalog the plan was computed against) and `reset_plan`. Phases: `planned` (backup taken and plan computed, nothing replaced), `applied` (the restored data and, for `replace`, its reset epochs were activated **in one step**: the epochs are written into the validated staging copy, which then replaces the live database with a single backup step, so data and metadata can never be observed apart; `apply_authoritative_restore` also refuses a journaled plan that no longer exceeds the current live and snapshot generations, and is a no-op when the live database already sits exactly at the plan). `resume_sync` refuses a record that is unreadable or still `planned`: the record is the only journal of an unknown data state. `recover_restore` resolves those: `rollback` restores `backup_path` (in any phase that has one), `complete` re-applies `source_path` with the journaled plan and then publishes/resolves, `discard` acknowledges a record that changed nothing (unreadable, or `planned` before any backup was taken). A failing recovery step keeps the record and the pause. Publication hands the plan to GossipSub; it is not proof that a peer adopted it — the repair pass and epoch checks establish that afterwards, and a peer holding a newer epoch still wins.

Database restore scopes (`import_database`, parameter `scope`):

| Scope | Effect | Synchronization |
| --- | --- | --- |
| `local` (default) | Replace this node's database from the file (pre-import backup is kept beside it). | On the synchronized default database, synchronization is **paused** (`sync_paused: true`) until `resume_sync`; inbound updates, resets and requests are held, repair and join reconciliation are skipped, outbound publishes are not sent. The operator must choose what the restore means before peers merge into it. |
| `fork` | Restore into a new isolated app namespace (`<app>-fork-<uuid>`). The destination directory is reserved with create-new semantics before the identity is returned, so a colliding id or a concurrent fork retries instead of sharing a namespace. | Nothing shared changes; named apps are never synchronized. |
| `replace` | Replace this node's database AND make it authoritative (R2-XD-02): the reset plan covers the **union** of the pre-restore catalog and the restored one, and every collection's new epoch exceeds both its live pre-restore epoch and the snapshot's (`replace_from_file_authoritative`). Collections the snapshot omits get a reset epoch too, so peers clear them instead of rediscovering them. The plan is persisted in the pending-restore record before it is published and re-applied idempotently after an interruption. | Peers adopt the reset and fetch this node's state; their pre-restore state is discarded. A peer holding an even newer epoch (concurrent authority) makes this node adopt that reset instead: the policy is monotonic, not last-operator-wins. |

Legacy snapshots (R2-XD-03): `replace_from_file` never modifies the source file. It copies the snapshot into a private staging database, runs this revision's idempotent schema initialisation on the copy (a snapshot from before reset epochs gains `collection_epochs`), validates every record row and CRDT document there, and only then copies the migrated staging database over the live connection. A snapshot missing a core table is rejected before any mutation; a staging failure leaves the live database untouched and usable.

Fork identities (R2-XD-04): `scope: fork` allocates `<label>-fork-<uuid>` and retries while the destination path exists or is open, so two forks in the same second are independent and an existing namespace is never reused as a fork target.

Retention and compaction rules (explicit so the offline window is knowable):

- Tombstones and epochs are retained **indefinitely**. There is no compaction of tombstones today, so there is no offline window after which a rejoining peer silently diverges: an obsolete peer is either brought forward by epochs/tombstones or refused. Any future compaction must define a retention window at least as long as the supported offline period and document what happens to a peer that exceeds it.
- `compaction` in the benchmark harness means SQLite `wal_checkpoint(TRUNCATE)` + `VACUUM`; it does not discard tombstones or CRDT history.

## 4. Bulk import with a durable completion signal (SN-01)

`import_records(batches)` validates every batch (non-empty collection names, non-empty ids, records that belong to their batch) before writing, applies all batches in **one** SQLite transaction with the existing savepoint machinery, and returns `ImportSummary` only after the commit. The deltas it produced are published after the commit, never before. A failure anywhere leaves every collection exactly as it was. The regression tests cover a failing second batch, replace-style tombstoning seen by a peer, duplicate imports and an immediate reopen after the returned summary.

## 5. Verification

```sh
cargo test --locked -p xdb --no-default-features
cargo test --locked -p xdb
cargo clippy -p xdb --all-targets
npm run typecheck -w @xdb/react && npm test -w @xdb/react
# XD-04 baseline (see docs/benchmarks.md)
XDB_BENCH_LARGE=1 cargo test -p xdb --release -- --ignored --nocapture bench_persistence
```

Dialing after discovery (found by the two-container run, 15 September 2026): libp2p's default dial reuses the listening port as the source port. Two peers that discover each other in the same instant (both answering the same mDNS query, which is what two nodes starting together do) then dial each other at once with mirrored 4-tuples; the kernel merges the two dials into one TCP simultaneous open, both sides run the Noise handshake as initiator, both fail with "input error", and nothing retried, so the peers never connected until one of them restarted at a different moment. The node now dials a discovered peer itself from a fresh source port (`allocate_new_port`), registers it as an explicit GossipSub peer only once the connection exists (so GossipSub never issues its own port-reusing dial), and retries a failed dial up to `MAX_DIAL_RETRIES` times with exponential back-off jittered by both peer ids. Outgoing and incoming connection failures are logged.

A live two-machine LAN run (discovery, partition, reconnect) is still a manual check with two demo instances. Short of that, `two_nodes_discover_deliver_partition_and_reconcile_over_loopback` (ignored by default; `cargo test -p xdb -- --ignored two_nodes`) runs two real `NetworkNode`s in one process over loopback sockets: mDNS discovery, GossipSub delivery, one node shut down while both sides write, a restart under a new peer identity on the same database, convergence in both directions with no manual sync request, and live delivery after the reconnect. Recorded 14 September 2026 on Windows 11: passes in about 35 s. The database-level tests exercise the convergence, epoch and import semantics that the network loop calls.
