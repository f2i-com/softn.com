# FormLogic runtime repair

This local candidate forward-ports the reviewed storage/XDB and migration repairs onto SoftN `cf10cf1` and adds the composition-event correction. The published `v0.0.20` at that upstream revision does not contain these repairs. The candidate uses the verified ZIPP 0.0.23 inputs, but has its own source and artifact hashes. Qualification of an earlier unpublished candidate does not transfer; the integration handoff records the exact revisions, hashes and fresh checks.

## Hosted storage contract

The [host shell](../apps/formlogic-host/src/main.tsx) advertises `storageProtocol: 1` and enables acknowledged persistence only when the FormLogic parent negotiates that capability. The paired FormLogic implementation must acknowledge mutations and commit a replacement batch atomically. Parent-side principal/app namespaces and session fences remain necessary: this iframe protocol does not establish account isolation by itself.

The [storage adapter](../apps/formlogic-host/src/storage.ts) keeps synchronous reads and optimistic writes, while each admitted mutation receives its own immutable identity, completion promise and `pending`, `confirmed`, `failed` or `unknown` state. Confirmation requires a matched reply with own data fields containing `result.saved === true` and no error field; malformed, inherited and accessor acknowledgments cannot report success. Inputs and queues are bounded before cache mutation.

The [backend queue](../apps/formlogic-host/src/backendQueue.ts) preserves current action-name validation and `BACKEND_INVALID`. Ordinary calls retain their existing timing. Storage calls use one absolute deadline: unsent cancellation differs from a sent operation with an unknown outcome. A sent timeout retains the parent's slot until its correlated reply or terminal disposal. A late acknowledgment can update state, but cannot resolve an already rejected completion again or replay the write. Disposal cancels waiting work and prevents stale startup or dispatch.

[XDB](../packages/@softn/core/src/runtime/xdb-service.ts) async mutations await their own receipts. Multi-collection imports use one preflighted replacement batch; failed imports do not overwrite later edits as compensation. Idle settlement is not proof of saving. Legacy parents retain optimistic synchronous storage, but cannot support durable XDB success claims or hosted batch imports. Ordinary standalone browser storage keeps its existing behavior.

## Migration and keyboard contracts

The [PHP-host migration helper](../apps/softn-host-php/runtime/migrations.mjs) preflights SQL and scopes the authorizer to each statement. Its narrow nullable `TEXT` addition grammar, optionally referencing one app-table column, permits only SQLite's internal `quick_check` for the verified target. Guest `PRAGMA`, host-private tables and other forbidden operations remain denied. Current setup deadlines, `migration_stopped` reporting and migration-only opcode-budget relaxation/restoration are preserved. Application migrations and their ledger entries are not rewritten.

The [event extractor](../packages/@softn/core/src/runtime/event-props.ts) copies keyboard `isComposing` as the strict boolean comparison `=== true`. Sanitized markup callbacks can honor composition-Enter guards without receiving raw DOM or `nativeEvent` objects.

## Rollback and qualification

Rollback must treat the runtime and paired FormLogic storage capability as a compatible set. Preserve saved maps and migration ledgers; do not adopt legacy unbound snapshots, replay unknown writes, or undo application migrations merely because host code is downgraded. Export unsaved work and resolve pending/unknown outcomes before replacing a runtime. Restoring older code removes these guarantees and may again reject nullable-TEXT migrations or mishandle composition events.

Fresh source and offline regression results support these contracts. They do not qualify actual Coffee import/upgrade, OTP authentication in a browser, account switching across a deployed parent/runtime pair, persistence after full restart, or production operation. Those require a separately authorized disposable-host run on the exact paired candidate. No publication or prior live qualification is implied by this document.
