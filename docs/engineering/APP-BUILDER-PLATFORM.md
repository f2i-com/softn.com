# SoftN App-Builder Platform Capabilities

SoftN v2 provides general-purpose platform primitives enabling sandboxed applications (such as CRUD.software, Narrator, Diagram.computer, and other application builders) to import data, migrate schemas, package validated `.softn` bundles, preview generated applications in isolated nested containers, and offer bundles for host deployment — all without weakening sandbox boundaries.

## 1. Guest Modules

| Module | Purpose | Permission |
| --- | --- | --- |
| `softn:sqlite` | Named SQLite access (`open`), dynamic DBs (`create`, `importBytes`), isolated temporary workspaces (`createWorkspace`), lossless 64-bit / decimal / BLOB transport, snapshots, schema inspection, integrity checks, `flush()`, `dispose()`. | Direct `open` requires no configured backend; temporary workspaces & binary imports require `sqlite-workspace`. |
| `softn:bundle` | Dynamic `.softn` ZIP packaging (`bundle.create()`), manifest/permission/migration validation (`validate()`), deterministic SHA-256 build fingerprint, `download()`. | None (ordinary sandboxed computation; saving to disk uses explicit host save confirmation). |
| `softn:files` | Chunked large-file reading (`files.pick()` -> inspect `file.size` -> `for await (const chunk of file.chunks())` with cancellation & progress) and streaming export (`files.createWriter()`). | `files` for picking host files; explicit host save confirmation on export. |
| `softn:apps` | Dynamic nested app preview (`apps.preview()`) backed by container-owned `softn-artifact:<id>` handles (never raw `blob:`/remote URLs) and host deployment handoff (`apps.offerToHost()`). | `app-preview` for previews; `app-deploy` for host offers (always denied inside nested/previewed apps). |
| `softn:runtime` | Live host-computed capability & limit discovery (`runtime.capabilities()`). | None (read-only). |

## 2. Capability Schema v5

Three narrowly scoped capabilities were added to `CAPABILITIES` (`CAPABILITY_SCHEMA_VERSION = 5`):
- `sqlite-workspace` — Create isolated temporary SQLite workspaces and import/export SQLite database binaries.
- `app-preview` — Run dynamically generated `.softn` application previews inside isolated, non-persistent nested containers.
- `app-deploy` — Offer a validated `.softn` application bundle to the host for user-confirmed deployment or update.

Direct frontend `softn:sqlite` `open()` remains **strictly disabled** whenever an application declares or connects to a backend. Temporary workspaces (`sqlite-workspace`) run in a separate ephemeral XDB instance with zero access to backend databases or backend VFS files.

## 3. Lossless SQLite Value Transport & Persistence

- **Lossless JSON Scanner (`sqlite-codec.ts`)**: Parses XDB's JSON result strings without IEEE-754 `JSON.parse()` rounding, preserving signed 64-bit integers (`-9223372036854775808`..`9223372036854775807`) as `{ type: 'integer', value: string }`, BLOBs as `{ type: 'blob', hex: string }`, exact financial decimals as `TEXT`, and distinguishing `null` vs `""` vs `0`. Unsigned 64-bit overflows (`> 9223372036854775807`) are rejected by default or mapped to `TEXT` when `unsignedOverflow: 'text'` is requested.
- **Reliable Persistence**: `LocalBackendTransport` stores versioned records (`format: 'softn-sqlite-v1'`, `revision`, `checksum`, `schemaVersion`, `tabId`), tracks explicit persistence states (`saved`, `saving`, `unsaved-changes`, `storage-limit-reached`), propagates IndexedDB/quota/abort/conflict errors instead of silently resolving, supports `flushAndAck()`, and rejects `exportSnapshot({ consistency: 'committed' })` while a transaction is active.
- **Declarative Schema Migrations**: `manifest.json` `databases[].schemaVersion` and `databases[].migrations` run versioned SQL upgrades recorded in `_softn_migrations` (with SHA-256 checksums + `PRAGMA user_version`), backing up a pre-upgrade binary snapshot and restoring automatically if any migration step fails.

## 4. Official React + TypeScript + PHP Slim Reference Profile

See [`examples/fullstack-crud/`](../../examples/fullstack-crud/README.md) for the official reference bundle combining:
- Uncompiled React + TypeScript (`.tsx`) frontend executed directly by SoftN's TypeScript/JSX tier.
- Pre-bundled PSR-4 autoloader + PSR-7/Slim-compatible routing & middleware in `backend/vendor/` (zero runtime Composer execution).
- Parameterized PDO SQLite queries, transactions (commit + rollback), lossless stringified 64-bit IDs & TEXT decimals, and declarative schema migrations.

## 5. XDB v0.1.2 & `zipp-php.wasm` Empirical Compatibility Notes

Verified against bundled `xdb-wasm.wasm` (v0.1.2) and `zipp-php.wasm`:

| Feature | Status | Notes |
| --- | --- | --- |
| Signed 64-bit integers (`INTEGER`) | Supported (lossless via `sqlite-codec.ts`) | XDB emits exact 64-bit literals & `bigint` `last_insert_rowid()`; `ExactJsonScanner` avoids `JSON.parse` rounding. In `zipp-php.wasm`, native PHP ints are f64-backed (~53-bit), so PHP endpoints should `CAST(col AS TEXT)` or store >53-bit IDs as `TEXT`. |
| Binary `BLOB`s, `NULL` vs `""` vs `0` | Supported | Round-tripped losslessly via `{ type: 'blob', hex }` / XDB `{ __blob: [...] }`. |
| Composite primary keys & `UNIQUE` | Supported | Enforced natively by XDB. |
| Transactions (`BEGIN` / `COMMIT` / `ROLLBACK`) | Supported | Enforced natively in both XDB and PHP PDO. Note: in `zipp-php.wasm`, catch `\PDOException` explicitly (and wrap as `new \Exception($e->getMessage())` if rethrowing) when rolling back failed PDO statements. |
| SQLite binary import/export & `PRAGMA user_version` / `query_only` | Supported | Standard `SQLite format 3` snapshots reopen cleanly; malformed binaries fail safely. |
| Foreign key enforcement & `ON DELETE CASCADE` | **Limitation in XDB v0.1.2** | `PRAGMA foreign_keys = ON` and DDL `REFERENCES ... ON DELETE CASCADE` parse cleanly, **but XDB v0.1.2 does not enforce FK constraints or cascades at write time, and `PRAGMA foreign_key_list` returns empty rows**. SoftN mitigates this in `getSchema()` (DDL `REFERENCES` parser fallback) and `integrityCheck({ checkForeignKeys: true })` (explicit SQL `LEFT JOIN` orphan scan). Generated PHP/JS backends requiring strict FK/cascade semantics should validate parent references and delete children explicitly inside transactions until an updated XDB engine enforces FKs natively. |

## 6. FormLogic Binary Handoff Contract

`apps/formlogic-host` advertises `binaryAppOffer: 1` and `dynamicPreview: 1` in `formlogic:ready` and bridges `softn:apps` `offerToHost()` to the bounded `formlogicOfferBundle` host action (max 64 MiB binary, validated SHA-256 & manifest summary, zero host auth tokens exposed to guest). Implementing the server-side `.softn` binary importer / confirmation UI in the external `f2i-com/formlogic.com` repository completes the one-click hosted publish loop; hosts that have not yet implemented `formlogicOfferBundle` return `{ ok: false, status: 'unsupported' }` so apps fall back cleanly to `.softn` file download.
