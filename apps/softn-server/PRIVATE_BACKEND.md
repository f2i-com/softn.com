# Private server API v1

`softn-server` implements native private application backends in ZIPP, paired
with a separate client bundle hosted by `softn-single`. The browser
receives the client artifact; the native server loads the private directory
containing `server/main.logic`, its manifest and SQL migrations.

## Build and run

From the SoftN repository:

```powershell
cargo test --manifest-path apps/softn-server/Cargo.toml
cargo build --release --manifest-path apps/softn-server/Cargo.toml
```

Build separate public client and private server artifacts, create the operator
registration below, then launch the private server:

```text
softn-server run <private-bundle-directory> --data-dir <private-data-directory> --workers 2 --port 3000
```

Use the same-origin reverse proxy in the application's deployment examples to
serve `softn-single` and forward `/api/*` to this listener. Enable
`--trusted-proxy` only when direct access is restricted to a trusted reverse
proxy that rewrites forwarded headers. The host uses the socket IP otherwise.

API v1 requires an explicit data directory. Its `backend.json` is operator-owned,
outside both the private deployment artifact and the public web directory:

```json
{
  "bundlePath": "/srv/apps/example-private",
  "capabilities": ["sql", "crypto", "time", "trusted-client-ip", "transaction-scope", "photos"],
  "development": false,
  "keyHex": "<32 random bytes encoded as 64 hexadecimal characters>"
}
```

Use a fresh OS-generated key, retain it across restarts, and restrict access to
the service account. Never print it or include it in a deployment bundle. Back up
this registration and key together with the database. Changing
the key invalidates pending OTP hashes and makes old encrypted outbox jobs
unreadable. `development` is controlled by this file, never by browser headers,
the bundle or the CORS `--dev` flag.

The canonical `bundlePath` must match the deployed private directory. Required
capabilities must all be explicitly granted. Legacy bundles cannot open a data
directory containing this registration. Multi-tenant mode enforces the same
registration for each `<data-dir>/<tenant-id>/backend.json`; a second bundle
choosing the same manifest ID cannot claim an existing registered directory.
Local filesystem ownership remains an operator responsibility.

## Manifest and runtime contract

The private manifest declares `server.requires.apiVersion: 1` and required
capabilities, `server.database: {kind:"private-sqlite", migrations:[...]}`, and
explicit `/api/` routes. Every private SQL route declares `transaction: "read"`
or `"write"` and `authorization: "application"`, `"anonymous"` or `"host-token"`.
Application handlers validate their own individual sessions. Host-token routes
require a configured operator token; the browser must never receive that token.
API v1 rejects legacy `public` flags and general HTTP/filesystem grants.

`server.sync.enabled: false` removes both `/sync` and `/sync/ticket` from single
and multi-tenant routers. Relational records are stored in `application.sqlite`,
separately from XDB's `xdb.sqlite`. Server fields and script paths are omitted
from the client manifest; operator token fields are redacted from public config.
Only an independently built client artifact should be made downloadable.

Supported script bindings:

| Binding | Behavior |
| --- | --- |
| `softn.serverApiVersion` | `1` |
| `softn.config.development`, `.photos` | Immutable operator-controlled flags |
| `softn.sql.query/first/execute(sql, parameters)` | Parameterized private SQL, row objects or `{changes,lastInsertRowid}` |
| `softn.crypto.sha256/hmac/randomHex/randomInt/equal/seal` | Native hashing, tenant-keyed HMAC, OS randomness, constant-time equality, authenticated encryption |
| `softn.time.now/age/parseZoned/format` | Trusted epoch clock, calendar age in a chosen timezone, validated IANA local time |
| `softn.media.sanitizePhoto(dataUrl)` | Optional `photos` capability; sanitized image and thumbnail |

`softn.time.age(date, timezone)` accepts a `YYYY-MM-DD` date and an optional IANA
zone (default `UTC`); specify the application's calendar zone explicitly.
`parseZoned(date, time, timezone)` accepts a `HH:MM` time and requires a zone.
`format(epochSeconds, timezone)` also requires a zone. The bridge supports all
IANA zones bundled with chrono-tz, including UTC. Invalid dates and daylight-saving
gaps/folds are rejected; an invalid birth date returns `-1`.

Crypto subkeys are HMAC-SHA256 of the master key and separate domain strings.
Defaults are `softn:hmac:v1` for HMAC and `softn:seal:v1` for encryption. Operators
can set `cryptoDomains: {"hmac":"example:sign:v1","seal":"example:jobs:v1"}` in
`backend.json` to interoperate with an existing service. Both domains must be
distinct printable ASCII strings of 1-128 bytes without spaces. Retain them
alongside the key: changing domains invalidates hashes or encrypted records.
AES-256-GCM output is base64 of `nonce(12) | tag(16) | ciphertext`. An operator
worker can derive the encryption subkey from the same key and seal domain to
decrypt the envelope; no decryption or key export binding is exposed to scripts.

## Transactions and bounds

Each request stays on one worker/SQLite connection. Write routes use
`BEGIN IMMEDIATE`, serializing conflicting writes before the handler reads state.
Read routes are denied DML by SQLite's semantic authorizer. There is no script
transaction handle or database-path API. SQL outside a host request transaction
is rejected, including script initialization.

The runtime validates and bounds the returned `{status,body}` before committing.
An exception, host error, invalid response, cancellation or deadline rolls back.
`rollback:true` explicitly rolls back and is removed before the HTTP response.
A normal error response without that flag commits: wrong OTP guesses therefore
retain their attempt counter. Worker faults and replacement drop/roll back the
connection. A dropped HTTP future marks the request cancelled; no network server
can guarantee that a client actually receives an already committed response, so
application mutations still need idempotency keys.

SQL uses an authorizer to deny attached databases, PRAGMAs, system/migration
tables, transaction control, extensions, virtual tables and unapproved functions.
Statements are limited to one, 20 KB text, 100 scalar binds, 1,000 returned rows
and 2 MiB of serialized result data. Unsafe JavaScript integers and blobs are
rejected. SQLite length, parse, expression and instruction limits apply before
unbounded results are materialized. Each transaction has a five-million SQLite
instruction budget and a 25-second deadline; lock acquisition waits at most
three seconds. Queue saturation and database contention return retryable `503`
responses. Retry the same action with the same idempotency key.

API v1 requires object JSON bodies and `application/json` for nonempty bodies.
Request bodies default to 2 MiB. A route may declare `maxBodySize` in bytes,
between 1 and 16 MiB; `config.server.maxBodySize` independently limits all routes
and must permit the same size. For a 4 MB base64 photo, use 5,600,100 bytes on
the upload route and global limit. Responses remain capped at 2 MiB.

Migrations run before readiness in one immediate transaction, in sorted order.
The private `_migrations` ledger retains immutable SHA-256 checksums. Removed or
changed historical migrations stop startup. Migration paths must remain inside
the deployment artifact, and migrations cannot attach other files or edit the
ledger. Supported migration operations are ordinary table/index creation,
deletion and DML; triggers, views, virtual tables and arbitrary PRAGMAs are not
supported. Missing handlers and failed `onStart()` also prevent readiness.

## Photos, SMS and operations

The photo bridge accepts still JPEG, PNG and WebP files up to 4 MB and 16
megapixels, with dimensions between 32 and 8,192 pixels and at most 64 MiB of
decoded pixels. It rejects PNG/WebP animation, applies EXIF orientation, and
re-encodes a 960-pixel JPEG (maximum 400 KB) plus a 240-pixel thumbnail (maximum
60 KB). Original EXIF/GPS/text metadata is not copied. It neither reads nor
writes files. The application authenticates and enforces its upload quotas before
invoking the sanitizer, then stores the results in private SQL.

Decoding runs in the assigned native worker inside the request transaction.
Image byte/pixel/output limits and decoder allocation limits constrain work;
decoder allocation limits are library best-effort rather than an OS memory
quota. Busy deployments should measure photo latency and move processing into
a separately constrained service before raising limits. These checks are not
content moderation or identity verification.

External delivery (for example SMS or email) belongs in a separate operator
process that leases jobs from private storage. Provider credentials stay in
that process. A worker can use the encryption contract above to read sealed
jobs without exposing secrets to the VM. The native VM cannot read
process environment values: `env.get()` returns null and `env.keys()` is empty,
while logging remains available. This intentionally changes legacy ambient
`APP_*`/`SOFTN_*` environment access; move any needed non-secret settings into
explicit app configuration.

Stop serving a deployment before applying schema upgrades. Back up SQLite with
its backup API or a coordinated snapshot/checkpoint; copying only the main file
while WAL is active can omit committed data. The SQLite main-file page limit is
512 MiB at its default page size. WAL, decoder memory, CPU, backups and total
storage still need service/container/filesystem limits. There is no automatic
backup scheduler, upload moderation service or distributed-write coordination
in this patch.

## Verification

The native Rust tests cover SQL escape denial, isolated databases, read-only
routes, cancellation and rollback, real ZIPP commit/rollback semantics,
migration checksums/atomicity, operator ownership/grants, fail-closed readiness,
crypto envelopes, timezone gaps/folds, and photo orientation/metadata/animation
handling. Test each application's actual packaged handlers through native HTTP
using disposable development data, including concurrency, upload limits and
authorization. Keep external delivery workers disabled for integration tests.
