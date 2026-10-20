# FormLogic runtime repair

SoftN v0.0.21 (`073339d`, ZIPP v0.0.24) ships the storage/XDB and migration repairs and the composition-event correction that were qualified on 2026-10-13 as a candidate on `cf10cf1` (ZIPP 0.0.23; [the record](QUALIFICATION_STATUS.md)). It ships them with `afb03bc`, which gave a FormLogic without acknowledged storage back the storage it had (the candidate counted every save there as failed). The FormLogic side of the pair is FormLogic's `809f80a1` and later, which negotiates storage protocol 1. v0.0.20 has none of this.

## Hosted storage contract

The [host shell](../../apps/formlogic-host/src/main.tsx) announces `storageProtocol: 1`, and enables acknowledged persistence only when the FormLogic parent sends that capability back. The paired FormLogic implementation must acknowledge each mutation and commit a replacement batch atomically. Parent-side principal/app namespaces and session fences remain necessary: this iframe protocol does not establish account isolation by itself.

The [storage adapter](../../apps/formlogic-host/src/storage.ts) keeps synchronous reads and optimistic writes for both kinds of parent:

- **Protocol 1.** Each admitted mutation gets its own immutable identity, a completion promise, and a state of `pending`, `confirmed`, `failed` or `unknown`. A write is confirmed only by a matched reply whose own data fields contain `result.saved === true` and no error field; malformed, inherited and accessor acknowledgments cannot report success. Inputs and queues are bounded before the cache changes (`STORAGE_LIMITS`): 32 outstanding writes, and 32,768 characters per write as sent. A write sent and not answered within its deadline (twenty seconds from admission) has an unknown outcome, and later writes are refused until the parent answers or the app is opened again.
- **Protocol 0, a parent that does not negotiate.** Legacy parents retain optimistic synchronous storage, as before v0.0.21. A reply without `error` is a save, and one with `error` shows the failed-save alert. Nothing is refused, held back or expired on the way, and closing the page does not ask.

The [backend queue](../../apps/formlogic-host/src/backendQueue.ts) keeps action-name validation and `BACKEND_INVALID`, and ordinary calls keep their timing. Protocol-1 storage calls use one absolute deadline: an unsent cancellation is told apart from a sent operation with an unknown outcome. A sent timeout keeps the parent's slot until its correlated reply or terminal disposal. A late acknowledgment can update state, but it cannot resolve an already rejected completion again or replay the write. Disposal (`formlogic:dispose`, or a `pagehide` that does not keep the page in the back/forward cache) cancels waiting work and prevents stale startup or dispatch. A message the port cannot deserialise fails what is in flight and leaves the app running.

[XDB](../../packages/@softn/core/src/runtime/xdb-service.ts) async mutations await their own receipts on a protocol-1 parent, and multi-collection imports use one preflighted replacement batch. Failed imports do not overwrite later edits as compensation, and idle settlement is not proof of saving. On a protocol-0 parent XDB makes no durable success claim:

- `createAsync`, `updateAsync` and `deleteAsync` update the records and then reject with `persistence-unsupported`;
- imports and restores are refused;
- its status is `degraded` and not `persistent`;
- closing the page asks first.

Ordinary standalone browser storage keeps its existing behaviour.

## Migration and keyboard contracts

The [PHP-host migration helper](../../apps/softn-host-php/runtime/migrations.mjs) preflights SQL and holds the authorizer to each statement. A narrow grammar admits `ALTER TABLE [main.]t ADD [COLUMN] c TEXT`, optionally `REFERENCES` one column of another app table. For that one statement only, the helper lets through SQLite's internal `quick_check`, which SQLite runs when a column is added to a STRICT table. Guest `PRAGMA`, host-private tables and other forbidden operations remain denied. A migration file with a NUL, or with a quote or comment left open, is refused before any of it runs. The setup deadline, `migration_stopped` reporting, and relaxing and then restoring the opcode budget for migrations only, all work as before. Application migrations and their ledger entries are not rewritten.

The Rust host does not have this repair. It refuses the internal check, so such a migration fails there (the `rust` notes in `apps/softn-host-php/tests/sql-parity.json`). An app meant for both hosts should not add a column to a STRICT table in a migration.

The [event extractor](../../packages/@softn/core/src/runtime/event-props.ts) copies a keyboard event's `isComposing` as the strict boolean comparison `=== true`. Sanitized markup callbacks can honour composition-Enter guards without receiving raw DOM or `nativeEvent` objects.

## Rollback and qualification

Rollback must treat the runtime and the paired FormLogic storage capability as a compatible set. Preserve saved maps and migration ledgers. Do not adopt legacy unbound snapshots, replay unknown writes, or undo application migrations merely because host code is downgraded. Export unsaved work and resolve pending or unknown outcomes before replacing a runtime. A runtime older than v0.0.21 has none of these guarantees, and it again refuses nullable-TEXT migrations on STRICT tables and passes composition events through unmarked.

v0.0.21 passed:

- SoftN's CI and release gates, on Linux;
- a local Windows gate: every workspace suite, the Rust host's 159 tests and the 29 browser journeys.

The live paired-host qualification the record lists as remaining has not been run: actual Coffee import and upgrade, OTP authentication in a browser, account switching across a deployed parent/runtime pair, persistence after a full restart, and production operation. Those require a separately authorized disposable-host run on the exact pair.
