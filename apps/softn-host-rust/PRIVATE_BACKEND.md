# Private server API v1

`softn-server` implements native private application backends in ZIPP, paired
with a separate client bundle hosted by `softn-single`. The browser
receives the client artifact; the native server loads the private directory
containing `server/main.logic`, its manifest and SQL migrations.

For an Apache/PHP deployment without a persistent service, use the optional
[PHP/WASM single-app distribution](../softn-host-php/SINGLE_APP_DEPLOYMENT.md).
This native host remains available for its broader native and synchronization capabilities.

## Build and run

From the SoftN repository:

```powershell
cargo test --manifest-path apps/softn-host-rust/Cargo.toml
cargo build --release --manifest-path apps/softn-host-rust/Cargo.toml
```

Build separate public client and private server artifacts, create the operator
registration below, then launch the private server:

```text
softn-server run <private-bundle-directory> --data-dir <private-data-directory> --workers 2 --port 3000
```

Use the same-origin reverse proxy in the application's deployment examples to
serve `softn-single` and forward `/api/*` to this listener. The host keys rate
limits on the client's address, so who may assert it matters:

- Without the flag the address is the socket peer. Behind a proxy that is the
  proxy, and every client shares one rate-limit bucket.
- `--trusted-proxy=10.0.0.5,10.1.0.0/16,::1` names the peers allowed to speak
  for a client (addresses or CIDR ranges, IPv4 and IPv6). When the peer is
  listed, `X-Forwarded-For` is walked from the right past every listed hop
  to the first address that is not one; a client cannot choose its identity,
  because whatever it prepends sits to the left of the entry the edge
  appended. This is the same rule as the directory API's `trustedProxies`.
  The list is every `X-Forwarded-For` line of the request, in order, so a
  proxy that adds a line of its own instead of appending to the client's
  (HAProxy's `option forwardfor`) is read as it means; an entry that carries
  a port (`198.51.100.1:5555`, `[2001:db8::5]:443`) is its address; and an
  IPv4 client that reaches a dual-stack listener as `::ffff:a.b.c.d` is
  `a.b.c.d`, in the limits and in `req.client_ip`. All three as on the PHP
  host. (Only the first line used to be read, which let a client behind
  such a proxy name itself, and a port made every visitor the proxy.)
- Bare `--trusted-proxy` trusts whatever connects and takes the rightmost
  entry, as earlier releases did. Use it only for a listener no client can
  reach directly (a Unix socket, a loopback port behind the proxy).

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
explicit `/api/` routes. A private SQL route runs in a `"read"` or `"write"`
transaction; one that declares none (or `"none"`) gets a read for GET and a
write otherwise, as on the PHP host. Every route declares `authorization:
"application"`, `"anonymous"` or `"host-token"`. A GET route may set
`poll: true` (a 200 carries an `ETag` and `X-SoftN-Poll-Interval: 5000`, and a
matching `If-None-Match` is an empty 304 after the handler has run), and a POST
route of an app requiring `photos` may set `upload: "photo"` (the host
sanitizes the body's `data_url` and the handler receives `req.upload =
{sanitized, image, thumbnail}` with an empty body; a bad photo is 400
`photo_rejected`), both as on the PHP host.
Application handlers validate their own individual sessions. Host-token routes
require a configured operator token; the browser must never receive that token.
API v1 rejects legacy `public` flags and general HTTP/filesystem grants.

`server.sync.enabled: false` removes both `/sync` and `/sync/ticket` from single
and multi-tenant routers.

Sync is on unless the manifest turns it off, so who may open `/sync` matters:

- Every request (except `GET /health`) must name this host: its `Host` must
  be an address literal (`127.0.0.1:3000`, `[::1]:3000`, `192.168.1.10`),
  `localhost` or a `*.localhost` name, a name given with `--allowed-hosts`, or
  the host of an `allowedOrigins` entry — or the request must come through a
  `--trusted-proxy` peer, which answers for the names it forwards. Anything
  else is refused with 403 `host_not_allowed`. This is what stops DNS
  rebinding: a page at `http://evil.example:3000` whose name the attacker
  re-points at your machine sends `Host` and `Origin` that agree with each
  other, which the Origin check alone accepted.
  **Upgrading: a host reached by a DNS name without a trusted proxy in front
  (for example `softn-server run … --host 0.0.0.0` browsed as
  `http://myserver.lan:3000`) now needs `--allowed-hosts=myserver.lan`, and a
  host behind a reverse proxy needs `--trusted-proxy` (or `--allowed-hosts`
  with its public name).** The poker authority guide's systemd unit passes
  `--trusted-proxy`; its first sample command does not, and run that way
  behind nginx every request is now refused until one of the two is added.
- Every answer carries `X-Content-Type-Options: nosniff`, the errors and
  refusals included, as the PHP host's `.htaccess` sends it: a file of the
  bundle is only ever what its `Content-Type` says, never a page because a
  browser guessed so. A proxy in front may set its own; the host does not
  send a `Content-Security-Policy`, which is the page's to declare.
- A browser's handshake carries `Origin`, and the upgrade is refused (403)
  unless that origin is the host's own (the `Host` the request was sent to,
  or a trusted proxy's `X-Forwarded-Host`) or is listed in
  `config.server.allowedOrigins`. `--dev` with no list accepts any origin, as
  its CORS does. Before this check any web page a visitor had open could
  connect to a host on their machine and read and write the app's database.
  **Upgrading: a page served from another site that syncs here — an app
  played on softn.com whose `config.server.url` names this host, a builder
  on another port — is now refused until its origin is in `allowedOrigins`
  (`["https://softn.com"]`). With a token, that list is also what lets its
  `/sync/ticket` request past CORS. Behind a proxy that rewrites `Host`, list
  the public origin too (or pass `--trusted-proxy` so `X-Forwarded-Host`
  counts).**
- A handshake with no `Origin` is not a browser's, and must present a ticket
  from `POST /sync/ticket`, or a configured token as `?token=` (kept for
  existing scripts). With no token configured, `?token=` proves nothing and a
  ticket is required.
- Sync has a token of its own, the **sync token**: `config.server.token` in
  the manifest, or `SOFTN_SYNC_TOKEN` (serving many apps,
  `SOFTN_SYNC_TOKEN_<TENANT_ID>` only; there is no process-wide one). It is
  the token the app's browsers send, so it is given to everyone who has the
  bundle, and it opens `/sync` and `/sync/ticket` and nothing else. The
  operator token opens them too, for scripts the operator runs, and every
  route that is not public besides. The host refuses to start (serving many
  apps, refuses that app) when the two are the same token.
  **Upgrading: browsers no longer send `config.server.auth_token` for sync.
  It is the operator token, and a page that sent it gave every host-token
  route to anyone with the bundle. A host guarded by the operator token alone
  now warns at startup that no browser can sync: set a sync token, and keep
  the operator token out of the bundle (`SOFTN_AUTH_TOKEN`).**
- With a token configured, every handshake needs a ticket or a token, as
  before. The SoftN client asks `/sync/ticket` for a short-lived single-use
  ticket with `Authorization: Bearer <sync token>` and opens
  `/sync?ticket=…`; the long-lived token never appears in a URL.
- The host logs a warning at startup when sync runs with no token. A token is
  not required, so existing deployments keep working; set one, or turn sync
  off, for anything reachable from a network.
- `/sync/ticket` gives each client address (an IPv6 client's whole /64) a
  burst of 20 tickets that refills at 30 a minute, per app; past that it
  answers 429 with `Retry-After`. A full ticket table is 503 with
  `Retry-After`, not 401 (the client stops for good on a 401). The client
  backs off exponentially with jitter (from `reconnectDelay`, up to a minute)
  and never retries sooner than `Retry-After`. A foreign `Origin` is refused
  here too.
- Open sockets are capped per app at `config.server.maxSyncConnections`
  (default 1024); past it the upgrade is 503. A socket's messages and frames
  are capped at 4 MiB.
- An API route is refused (403 `origin_not_allowed`) when the request carries
  an `Origin` that is neither the page's own nor listed, before the handler
  runs. CORS only hides a cross-site answer; a `text/plain` POST from another
  site used to run the handler. Same-origin pages are unaffected; behind a
  proxy that rewrites `Host`, forward it (`proxy_set_header Host $host`) or
  send `X-Forwarded-Host` from a `--trusted-proxy` peer.
- A page on a listed origin is answered for its browser as it is served. A
  preflight is told the header names it asked for are allowed, as the PHP
  host tells it (the answer used to be `*`, which browsers do not take to
  cover `Authorization`, the header a session and the `/sync/ticket` token
  travel in), and `Access-Control-Allow-Origin` goes to the origins the
  check above lets through, compared the same way: an entry written
  `https://App.example/` used to run the handler and send its answer back
  without the header, so the page saw a failure for a request that worked.

The sync protocol's answers are now honoured by the SoftN client: an op stays
queued until the host's `sync_ack`; `sync_retry` (storage quota, a failing
hook, a busy database) puts it back and tries again after a backoff, where it
used to be dropped; an op still unanswered when the socket drops is sent again
on the next connection. Pushes go out in pieces of at most 500 ops and 1 MB.
On the host, an op whose `recordId` belongs to a different collection than the
one it names is rejected (a hook that guards one collection could otherwise be
bypassed by naming another), a pull reads each named collection once (at most
100 per pull) and `sync_state` and `sync_delta` messages go in pieces of at
most 1 MB, which the client, taking messages of up to 4 MiB, receives (see
"Sync protocol" below).

Request traces log the path only; a query string (`?token=`, `?ticket=`) is
logged as `?<redacted>`. A script sees the request's headers minus `Cookie`
and `Proxy-Authorization`, and minus `Authorization` wherever the host checked
it against its own token (a `host-token` route, or a legacy non-public route on
a host with a token), since there it is the operator's secret. On an
`application` or `anonymous` route `Authorization` is the app's own session
and is forwarded, as on the PHP host.

Relational records are stored in `application.sqlite`,
separately from XDB's `xdb.sqlite`. Server fields and script paths are omitted
from the client manifest; operator token fields are redacted from public config.
Only an independently built client artifact should be made downloadable.

Supported script bindings:

| Binding                                                   | Behavior                                                                                           |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `softn.serverApiVersion`                                  | `1`                                                                                                |
| `softn.config`                                            | The app's `config.app` settings under the operator's `.development` and `.photos`; frozen          |
| `softn.sql.query/first/execute(sql, parameters)`          | Parameterized private SQL, row objects or `{changes,lastInsertRowid}`                              |
| `softn.crypto.sha256/hmac/randomHex/randomInt/equal/seal` | Native hashing, tenant-keyed HMAC, OS randomness, constant-time equality, authenticated encryption |
| `softn.time.now/age/parseZoned/format`                    | Trusted epoch clock, calendar age in a chosen timezone, validated IANA local time                  |
| `softn.media.sanitizePhoto(dataUrl)`                      | Optional `photos` capability; sanitized image and thumbnail                                        |

There are no timers. `setTimeout`, `setInterval`, `clearTimeout` and
`clearInterval` throw an Error saying so, on this host and the PHP host alike:
a handler runs once and nothing runs after it returns.

`softn.config` is the manifest's `config.app` object, key for key, with the two
flags the operator owns set over it: an app key named `development` or `photos`
is replaced, so a bundle cannot turn development mode on for itself. The PHP
host gives a script the same settings under the same two flags (there
`photos` also needs PHP's GD). The object is frozen all the way down: a
handler reads its settings and cannot change them. `config` is part of the manifest every client is served, so
nothing in it is a secret; keys and tokens belong in `backend.json`.

`db.query(collection, filter)`, on the document store (which the PHP host
does not have), answers with the records whose data has every field of
`filter`, compared as a script's `===` compares them. The filter is applied
in the host's query, so the 10,000 records one query reads at most are
10,000 that match, oldest first; an unfiltered `db.query(collection)` is the
oldest 10,000 records of the collection, and the log says so (at most once a
minute) when either stops there. A filter of more than 16 fields is applied
by the script alone, to the oldest 10,000.

`softn.sql.execute` answers `{changes, lastInsertRowid}`. `lastInsertRowid` is
the id of a row that statement inserted, and 0 when it inserted none: an
`INSERT OR IGNORE` that was ignored, an upsert that updated, an `UPDATE`, a
`DELETE`. On both hosts. SQLite itself keeps the last id a connection
inserted, and a worker keeps its connection, so such a statement used to
answer with a row an earlier request had made.

An object keeps the order of its keys across the host, as on the PHP host:
the body and query a handler receives, the columns of a row, and the body it
returns. (They used to be sorted by name on this host.)

`softn.time.age(date, timezone)` accepts a `YYYY-MM-DD` date and an optional
zone; none, `null` or `""` is `UTC`. Specify the application's calendar zone
explicitly. `parseZoned(date, time, timezone)` accepts a `HH:MM` time and
requires a zone. `format(epochSeconds, timezone)` also requires a zone, drops
any fraction of a second, and writes `Thu, 1 Jan, 11:00 pm · Melbourne`: the
weekday, the day and month (`June` and `July` in full, `Sept`), the hour by
a twelve-hour clock, and the last part of the zone as the caller spelt it.
A zone is an IANA name in any case (`australia/melbourne`), or an offset
from UTC written `+10:00`, `+1000` or `+10`. Invalid dates and
daylight-saving gaps/folds are rejected; an invalid birth date returns `-1`.
All of this is the PHP host's, and the two are held to one list of calls
(`apps/softn-host-php/tests/time-parity.json`); this host used to write
`Thu, 1 Jan 2026, 11:00 PM AEDT` and to take only a zone spelt exactly as
the IANA list spells it. `softn.crypto.randomInt(bound)` and
`randomHex(bytes)` take a whole number or text that spells one, the bound
up to 2^53-1, on both hosts (`tests/crypto-parity.json` beside it).

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
three seconds. Failures answer as on the PHP host: queue saturation and
database contention are 503 `database_busy`, a handler that runs out of time
503 `runner_unavailable` (it used to be 504), and a handler that throws or
answers an invalid response 500 `host_error`; the 503s are retryable. Retry
the same action with the same idempotency key.

API v1 requires object JSON bodies and `application/json` for nonempty bodies.
A body may nest 62 levels deep, the body itself the first, which is as deep
as a handler can be handed; one level more is 400 `invalid_request`, on both
hosts (it used to be a 500 here, and on the PHP host a `null` in the handler).
A route accepts the smaller of its own `maxBodySize` and
`config.server.maxBodySize` when either is declared (1 byte to 16 MiB), else
2 MiB (5,600,100 bytes on an `upload: "photo"` route). The app's value used to
cap a route that declared more. A response may be 3 MiB as JSON, as on the PHP
host (it was 2 MiB here), with any one string in it at most 2 MiB.

One difference in what a body may hold: an object key, at any depth, that
begins with a NUL character (`{"\u0000k":1}`) is a key like any other here,
and on the PHP host the request is answered `400 invalid_request`, because
PHP's JSON decoder refuses such a property name. A NUL later in a key, a NUL
in a value and an empty key are taken by both.

A handler's answer and the host's own errors carry `Cache-Control: no-store`
and `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, as
the PHP host's do: the answer is for that request, and JSON is never a page.
A bundle's own files carry neither. On API v1 `req.headers.authorization` and
`req.headers["idempotency-key"]` are always present, empty when not sent (or
when the host kept `Authorization` for itself on a host-token route), again
as on the PHP host.

Every request runs in a VM of its own, as on the PHP host: nothing a handler
leaves in memory is there for the next request, on the same worker or
another. The VM that served a request is thrown away and the script compiled
and run again before that worker's next one, so the script's top level runs
once for each request. A VM used to be kept when every top-level variable
was a number, a string or the like, and only those variables were put back:
what a handler had hung on a function (`h.cache = …`), on `JSON`, on
`Object.prototype`, on `console`, or on a global it never declared, was read
by whoever that worker served next. The price is the compile: about a
millisecond a request for a small script and three for one of 20 KB, on one
worker (a script with an object, an array or a class at its top level
already paid it). Keep the top level cheap, and keep state in the database.

One push is one request, however many ops it carries. The per-op sync hooks
of a push (`onBeforeSync` for each op, and after the push is stored
`onAfterSync` for each) are run in order, one worker at a time, and the first
starts from the script as loaded, like any request. To spare a compile an op,
the next op's hook runs in the VM the one before it ran in, so it may find in
memory what that one left. That is a saving and not a promise: the hook after
one that threw or was cut off starts clean, and so does the first hook after
each tenth of a second, when the worker is handed to whatever else is waiting
and the rest of the push takes its turn behind it. A push whose hooks are slow
(one that calls out for each op, say) would otherwise hold a worker until its
last op, and on a pool of one every other request would wait for it. The next
push, and every HTTP request, starts clean. Keep what must last in the
database. A thousand ops with both hooks take about 30 ms; a compile for each
took 0.9 s for the before-hooks alone, against the five seconds a push is
given.

`onStart()` is one place the two hosts differ. Here it runs once, when the
app is loaded, on one worker and outside any transaction, and a global it
sets is discarded with that VM; an `onStart` that fails
stops the app from starting. On the PHP host `onStart()` runs for each
request as well, inside that
request's transaction. Write `onStart` to check what it needs and to create
nothing a request depends on being in memory, and both hosts run it alike.

Photo decoding is bounded across the host: as many decodes at once as there
are cores, between two and eight. An upload past that is answered 503
`database_busy`, the retryable answer, rather than queued. A decode can hold
64 MB and runs before the handler, so it used to be bounded only by the
rate limit, a minute's allowance at once.

Each client address (an IPv6 /64 counting as one) may make 120 requests a
minute to an API v1 app's routes, as on the PHP host, and is answered 429
`rate_limited` with `Retry-After` past that. `config.server.requestsPerMinute`
changes the number, 0 turns it off; a legacy bundle has no limit unless it
sets one. Behind a proxy, pass `--trusted-proxy` or every visitor shares the
proxy's allowance.

Migrations run before readiness in one immediate transaction, in sorted order.
The private `_migrations` ledger retains immutable SHA-256 checksums. Removed or
changed historical migrations stop startup. Migration paths must remain inside
the deployment artifact, and migrations cannot attach other files or edit the
ledger. Supported migration operations are ordinary table/index creation,
deletion, `ALTER TABLE` (add, rename and drop columns, rename tables) and DML,
with the date/time functions (`datetime`, `date`, `time`, `strftime`,
`julianday`, `unixepoch`) available to defaults and backfills, as on the PHP
host; triggers, views, virtual tables and arbitrary PRAGMAs are not supported.
Missing handlers and failed `onStart()` also prevent readiness.

A migration file may be 1,000,000 bytes, as on the PHP host (it was 262,144
here). Three things about migrations differ between the hosts, and a bundle
meant for both should stay inside each:

- Adding a column to a STRICT table, or a column with a CHECK, makes SQLite
  check the table with an internal `quick_check`, which this host refuses as
  a PRAGMA, so the migration fails. The PHP host lets that check through for
  exactly `ALTER TABLE t ADD [COLUMN] c TEXT`, optionally `REFERENCES` one
  column of another app table (`apps/softn-host-php/runtime/migrations.mjs`;
  the `rust` notes in `tests/sql-parity.json`). Do not add a column to a
  STRICT table in a migration.

- This host knows a migration by its file name, the PHP host by its path in
  the manifest. Here every migration must be a `.sql` file with a name no
  other has (`server/a/001.sql` and `server/b/001.sql` are refused), and a
  file may move to another folder; there two files may share a name, and
  moving one that has been applied stops the app (`database_migrations`).
  Give each file its own name and leave applied ones where they are.
- This host stops a migration after 5,000,000 SQLite steps or ten seconds
  and does not start; the PHP host has no step limit (its runner's twenty
  seconds bound it). A `CREATE INDEX` or a backfill costs about ten steps a
  row, so on a table past roughly half a million rows such a migration
  needs splitting (several files, each within the limit), or the work done
  with the server stopped.

A handler's request carries `client_ip` only when the app requires the
`trusted-client-ip` capability (legacy bundles always get it), as on the PHP
host.

## Photos, SMS and operations

The photo bridge accepts still JPEG, PNG and WebP files up to 4 MB and 16
megapixels, with dimensions between 32 and 8,192 pixels and at most 64 MiB of
decoded pixels. It rejects PNG/WebP animation, applies EXIF orientation, and
re-encodes a 960-pixel JPEG (maximum 400 KB) plus a 240-pixel thumbnail (maximum
60 KB). What a photo is, is read from its bytes; the label on the upload only
has to name one of the three types (a browser writes it from the file's
extension, and a PNG labelled `image/jpeg` used to be refused here).
Transparency is painted white (it used to come out as whatever lay under
it, black as a rule). Both as on the PHP host.
Original EXIF/GPS/text metadata is not copied. It neither reads nor
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

## Operating the server

Commands: `softn-server run <bundle>` (one app), `softn-server serve-multi
<bundles-dir>` (one app per directory or `.softn`, at `/<id>/…`), and
`softn-server info <bundle>`.

| Flag                                 | Meaning                                                                                                                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--port`, `-p`                       | Listen port (3000).                                                                                                                                                                                                                         |
| `--host`                             | Bind address, `127.0.0.1` by default. IPv6 (`::1`, `[::]`) works. Put a TLS-terminating proxy (nginx, Caddy) in front of anything reachable from a network: the server speaks plain HTTP, and a token sent over it is readable on the wire. |
| `--data-dir`                         | Operator data directory (required for API v1).                                                                                                                                                                                              |
| `--workers` / `--workers-per-tenant` | Script workers (1-200; the process as a whole has 200).                                                                                                                                                                                     |
| `--trusted-proxy[=<peers>]`          | Peers whose `X-Forwarded-For` / `X-Forwarded-Host` count (see above).                                                                                                                                                                       |
| `--allowed-hosts=<names>`            | Extra names this host answers to (see the Host rule above).                                                                                                                                                                                 |
| `--dev`                              | Permissive CORS and sync origins for bundles that list none. A development-machine flag: there is no environment variable for it, and it logs a warning when `--host` is not loopback.                                                      |
| `--allow-all-capabilities`           | Legacy bundles without a permissions block get `http` and `fs`.                                                                                                                                                                             |

Environment: `SOFTN_AUTH_TOKEN` (the operator token; in multi-tenant mode
`SOFTN_AUTH_TOKEN_<TENANT_ID>` first, with `.` and `-` as `_`),
`SOFTN_SYNC_TOKEN` (the sync token; in multi-tenant mode
`SOFTN_SYNC_TOKEN_<TENANT_ID>` and nothing else),
`SOFTN_ALLOW_ALL_CAPABILITIES=1`, and `RUST_LOG`, which replaces the default
log filter (`softn_server=info,softn_script=info,tower_http=debug`). Logs never
carry a query string, and scripts cannot read the environment.

`config.server` keys the host reads, checked at startup (a wrong type is an
error, not a silent default): `auth_token` or `authToken` (non-empty string;
the environment wins), `token` (the sync token, a non-empty string other
than the operator token; the environment wins), `allowedOrigins` (origins such as
`"https://app.example"`, no wildcard; a literal `"null"` is accepted with a
warning), `maxBodySize` (1-16777216), `workers`, `readPoolSize`,
`syncPermits`, `maxStorageMB`, `maxSyncConnections`,
`maxSyncConnectionsPerVisitor`, `requestsPerMinute` (whole numbers),
`bodyTimeoutSeconds` (1-600) and `forceServerTimestamps` (boolean). Serving
many apps (`serve-multi`), what a bundle may ask for itself is held to its
share of the one process: `workers` to the 200 worker threads divided among
the bundles (4 each for 50; `--workers-per-tenant` is the operator's and is
not held to it), `readPoolSize` to 16, `maxSyncConnections` to 1024, and
`maxStorageMB` cannot be 0 (no quota) there, which reads as the 10 GiB cap.

Connections: request headers must arrive within 30 seconds, and a request's
whole body within `bodyTimeoutSeconds` of them (60 by default, which is about
280 KB/s for the largest 16 MiB body and 95 KB/s for a photo upload; raise it
for slow clients sending large bodies). A body past its deadline is answered
JSON 408 `request_timeout` and the connection closed, however steadily it was
arriving; no more than 60 seconds may pass between two pieces of it either.
The PHP host leaves body reading to its web server (Apache's `mod_reqtimeout`,
nginx's `client_body_timeout`), so set a comparable limit there. An idle
keep-alive connection is closed after 30 seconds, so a proxy that pools
upstream connections should idle them out sooner. Unknown paths and methods
answer JSON 404/405, and a body over the limit JSON 413. HEAD on a GET route
is that GET with the body left off the answer: the handler is told the
method is `GET` (it used to be told `HEAD`), as on the PHP host. A handler's status
must be 200-599 (anything else is a 500), as on the PHP host.

A request is judged on its headers before its body is read: a name the host
does not answer to (403 `host_not_allowed`), a foreign `Origin` (403
`origin_not_allowed`) and a client over `requestsPerMinute` (429) are refused
without the host reading, or waiting for, a byte of the body. `/sync/ticket`
never reads one.

Sync sockets: at most `maxSyncConnections` per app (1024 by default; 503
`server_busy` past it), and at most `maxSyncConnectionsPerVisitor` of those
from one visitor (16 by default, never more than `maxSyncConnections`; 429
`too_many_connections` past it). A visitor is what the rate limits count: the
socket's peer, or the client a `--trusted-proxy` forwards for, with an IPv6
/64 counting as one. The client opens one socket per app per browser tab, so
16 is sixteen tabs from one address; raise it for an office or school behind
one NAT, and set `--trusted-proxy` behind a reverse proxy, or every visitor
shares the proxy's address and its 16 sockets. A place is returned when its
socket closes. (The PHP host's live-updates bridge, a different workload,
holds a visitor to 2 of its 8 connections.)

Stopping: Ctrl+C or SIGTERM (what systemd, Docker and Kubernetes send) stop
accepting, let requests in flight finish, and close sync sockets with 1001
before exiting (up to 40 seconds for each; a connection that will not finish
is left behind, where the process used to wait on it for ever).

Connections: 768 are served at once and the rest wait in the listen queue
(the process needs a file-descriptor limit above that; the default 1024 is
enough). An open sync socket is one of the 768 for as long as it is open, as
a kept-alive connection is: it used to be counted only until its upgrade, so
the sockets of the apps on one host could pass the descriptor limit and
leave none for anything else. A response the client does not read is dropped when 30 seconds pass
without the client taking a byte, on plain requests and on sync sockets
alike; a slow client is not affected, only one that has stopped. One sync
message has two minutes to leave at most.

Workers: a regular expression that backtracks for ever stops at the
engine's ceiling for one search, as a `RangeError` the handler can catch
(it used to hold its worker until the watchdog gave the thread up). A
handler stuck inside one native call (a huge `JSON.parse`) cannot be
interrupted, so its worker is abandoned and a replacement started, for up to eight such threads running at once. When an
abandoned thread's call returns the thread exits and its place is free
again. It used to be eight for the life of the process, after which every
further stall cost the pool a worker for good. At the limit, or when no
replacement can be started, the worker is left in the pool and serves again
when its call returns. A call that no worker took within 30 seconds is
logged as that, not as a wedged worker.

Multi-tenant: tenant IDs that differ only in case are one tenant (they would
share a data directory on Windows and macOS), and a `<name>_bundle` directory
unpacked beside `<name>.softn` is not loaded as a second copy of it. When two
bundles claim one id, the tenant is the one that served that id's data before:
each tenant's data directory holds a `.bundle` file naming the bundle (its
name in the bundles directory) that last served it. The other is refused
before it is unpacked or run, and both are named in the log. The record only
settles such a dispute: a bundle that is renamed, replaced by a new version
under another name, or moved to another bundles directory is loaded as ever,
and the record follows it. With no record the first by name is the tenant.
Bundles are loaded in name order.

Sync, pulls: a collection is sent a page of 10,000 records at a time. The
last `sync_state` of a page that was full carries `more: {at, id}`, and a
`sync_pull` naming that collection with `cursor: {at, id}` is answered with
the page after it; the runtime's client asks until a page is not full. A
collection past 10,000 records used to be pulled as its oldest 10,000 and no
further, on every device. A client from before this ignores `more` and has
what it had.

Sync, pushes: a push is answered (`sync_ack`) and broadcast to the other
clients as soon as its ops are stored. `onAfterSync` and `onAfterSyncBatch`
run after that, and the connection's next message waits for them, so one
client's pushes are still hooked in order. The answer used to wait for the
after-hooks, and a push whose hooks took long was told "timed out" and sent
again while the first attempt went on to commit. The per-op `onBeforeSync`
stops taking ops of one push after five seconds; the rest are answered
`sync_retry` and the client sends them again. The per-op `onAfterSync` stops
being started after five seconds as well; the ops are stored either way, and
the log says for how many of them it ran. Prefer `onBeforeSyncBatch` and
`onAfterSyncBatch`, which are one call for the whole push. The push's sync
permit is let go once its ops are stored, so its after-hooks do not keep the
next push waiting.

An update's data is the record's whole data, as the runtime's client sends
it: a key it leaves out is removed from the record. Updates used to be merged
into the record, so a key removed on a device (a field set to `undefined`, a
restored backup) stayed on the server and came back at every device's next
pull. An update with no `data` changes the record's time alone. A client of
your own that sends only the fields it changes must send the whole record.
The record is the last writer's, whole, as every client already takes a
server update: a field a route's `db.update` added is gone again if a client
then sends an update made on a copy from before that write. A route that
adds fields clients must keep can keep them in a record of its own.

A key a before-sync hook takes out of an update's data keeps the record's
value: the hook does not see the stored record, and deleting a key is how it
keeps a client from changing it (`delete op.data.role`). A hook that hands
back only some keys keeps the others as stored. A key a client leaves out
altogether is removed whatever the hook does with it; a hook that must keep a
field can refuse an update without it (`return false`). Every client, the
one that pushed included, is sent the record as stored.

The record an update leaves is held to what one op may carry (512 KB of
data): one that a hook's kept keys would take past it is refused
(`sync_reject`, "Record too large after this update"). A few merged updates
of new keys used to grow one record without end. A record already past the
limit can still be made smaller.

A pull is read a message at a time, and a connection holds two of its
messages at most: the one leaving and the next, which is read once the one
before that has left. So a pull goes as fast as its client takes it, and the
server holds two messages of it, not every collection it names; the messages
are the ones it always was. It used to read on as fast as the store gave
them, into the connection's queue: a client that asked for a large pull and
stopped reading had up to 512 messages of up to a megabyte held for it until
its socket was given up on. A pull under way waits for a sync permit between
messages rather than stopping part-way, and holds none while it waits for its
client.
Each message is read by the index on (collection,
server_received_at, id), from the record the one before ended on. The full
pull's query ordered by `COALESCE(server_received_at, '')`, which no index
holds, so every message read and sorted the collection to find its five
hundred records: twenty times a page, where a page had been one query.

Other clients are sent a push's ops in the order the pushes were stored: the
broadcast is made before the store's writer lock is let go. It was made
after, once the ops had been copied, so of two pushes stored one after the
other the second could be sent first, and a client, which applies what it is
sent as it comes, was left showing the older of two edits to one record.

An update for a record that has been deleted is refused (`sync_reject`), as
it always was, and its pusher is also sent the record as it stands, a
`delete` in a `sync_delta`. A full pull sends no deleted records, so that
device went on showing a record that was deleted everywhere else.

An update or a delete is weighed by when it was made (its op's timestamp):
one made before the record's last change is acknowledged and not applied,
and its pusher is sent the record as it stands in a `sync_delta` whose op
comes from `server` under the id of the op it answers (for a push that edited
a record and then deleted it, the delete's). That record, and the
acknowledgement just before it, travel in the same stream as the other
clients' edits, in the order the store wrote them. They went with the push's
answer, on the connection's own queue, and an edit stored after the record
was read could reach the pusher first and then be undone there by the older
record. A write the server makes itself (a hook's `db.update`) is stamped by
the server's clock, so a device whose clock was behind lost the edits it made
just after one. `auth_ok`'s `serverTime` is now given to the millisecond, and
the runtime's client stamps its edits in the server's time from it; a client
from before that stamps them by its own clock. `forceServerTimestamps` stamps
every edit by the server's clock instead, at the cost of an offline edit's
own time.

A push is one transaction and one saved CRDT document per collection it
touches. The document is as large as the collection, and it used to be
written again for every op of the push, under the store's one writer lock:
a push of 500 ops into a large collection held every other write on the
host for the length of 500 such writes. The one save per collection is the
XDB crate's `with_batch` (`crates/softn-xdb`).

Sync hooks: what `onBeforeSync` or `onBeforeSyncBatch` hands back as an op's
`data` must be an object no larger than a client may send (512 KB). Anything
else is not applied, and the client is told to retry, as when the hook
throws: a string or a number would have replaced the whole record. An op a
client sends with `data` that is not an object (in a create or an update) is
refused for good (`sync_reject`), for the same reason.

`onBeforeSync(op)` answers `false` to reject its op, and `null`, `undefined`,
`true` or an object to take it (`{ data }` to change its data). Any other
answer (a number, a string, a list) rejects the op: the `0` or `''` of
`return a && b` used to take it.

`onBeforeSyncBatch(ops)` answers with the ids of the ops it rejects (`op.id`,
not `op.recordId`): a list of them, where `null`, `true` and `false` name no
op (`ops.map(o => bad(o) ? o.id : null)`), or `{ rejected: [...] }`.
`ops: [{ id, data }]`, alone or beside `rejected`, changes those ops' data
and rejects none: an op it leaves out is taken as it came. `null`,
`undefined`, `true`, `{}` and `{ rejected: undefined }` reject none, and
`false` rejects them all, as `onBeforeSync`'s `false` rejects its op. Any
other answer refuses the whole push: a list naming anything but this push's
op ids (the ops themselves, `[{ id }]`, the records' ids), `false` and a
number used to reject nothing and let every op through.

### Sync protocol

The limits below are in `sync-protocol.json`, beside this file; a test on
each side (`src/sync_tests.rs`, and `xdb-server-sync-protocol.test.ts` in
@softn/core against the client's `SYNC_LIMITS`) holds the host and the
client to it. Either side refuses a message over 4 MiB: the host closes the
socket with 1009, the client drops it. A push carries at most 1,000 ops and
4 MiB of data, an op's data at most 512 KB; a pull names at most 100
collections, and a collection name is 1 to 64 letters, digits, `-` and `_`.

Pulls come in three forms, each answered with `sync_state` messages per
collection:

- `{type:"sync_pull", collections}`: the whole of each collection, live
  records only, a page of 10,000 at a time (`more`, then `cursor`, above).
- `{..., cursor:{at, id}}`: the page after the one whose last message said
  `more: {at, id}`.
- `{..., lastSync, lastId}`: what the host received after that point, deleted
  records included, as `{id, ..., deleted: true}`, so a client removes a
  record deleted while it was away (a whole pull lists live records only).
  The point is the host's own receipt time, `serverReceivedAt` on every
  record a pull sends, and the id of the record at it; never `updatedAt`,
  which is when the edit was made and may be long before the host saw it.
  At most 10,000 records per collection, and such an answer carries no
  `more`: a client that gets that many asks again from the last record it
  read.

Every record a pull or a delta brings is held to 1 MB per message: records go
in pieces, and only a record larger than that travels alone. A record a
client pushes is at most 512 KB; only one the server writes itself (a route's
`db.update`, which is not held to it) can be larger than a client takes.

`{type:"subscribe", collections}` names the collections whose changes a
client wants. A connection is sent the deltas of those, and of every
collection it pulls or pushes to after; one that never subscribes is sent
every collection's, as before (the host used to ignore `subscribe`). What
the host says to one client alone (an acknowledgement, a record as it
stands) is never held back.

Refusals say what was refused. A pull the host cannot take now (no sync
permit within two seconds, a step that failed or timed out) is answered
`{type:"error", message, for:"pull", collections, retryAfter}`: the
collections it did not send whole, and the seconds to wait. One it refuses
for good (too many collections, a name it does not take) has no
`retryAfter`. A push it cannot take now is answered
`{type:"sync_retry", opIds, reason}`, which every client already reads as
"send these again". Both used to be an `error` naming nothing: the client
never asked for the pull again, so a device whose first pull met a busy host
pushed nothing until it reconnected, and it took any `error` for its pushes,
which it sent again. A client from before reads the new fields' `error` as it
always read `error`.

An op the host stored in the last fifteen minutes (up to 10,000 of them) and
is sent again, by its op id, collection and record, is acknowledged and not
applied, broadcast or hooked again. An update or a delete sent again used to
be all three.

The pusher is sent a record as it stands, in a `sync_delta` from `server`
under the id of the op it answers and just after that op's acknowledgement,
when what it applied to its own copy is not what the host has: an edit
overtaken by a newer one (above); an op whose data a before-sync hook
changed, where it used to be sent only the acknowledgement and kept what it
had sent; and an update or a delete refused for good (by a hook, or for its
size), which used to stay on the device that made it, since no later pull
brings a record that has not changed. A refused create is left on the
device, which the app is told of: the host has no record to send back.

A write the server makes itself, a route's or a hook's `db.create`,
`db.update`, `db.updateIf`, `db.delete` or `db.hardDelete`, reaches every
connected client as another client's push does, with the whole record as
stored, in the order the store made it. It used to reach a device only when
that device next connected and pulled.

A frame the WebSocket layer refuses closes the socket with a code that says
why: 1009 for a message over 4 MiB (which used to end the connection with no
Close frame), 1007 for text that is not UTF-8, 1003 for a binary message
(which used to be passed over, the client left waiting on an answer), 1002
for any other protocol error. These were all 1000, a normal closure.

The index on (collection, updated_at, id) is dropped when an existing
database is opened: pulls go by `server_received_at`, and no query filters or
sorts on `updated_at`. The `auth` message clients used to send on open was
never read; clients no longer send it.

The legacy `http` bridge refuses private, link-local, unique-local (including
cloud metadata such as `fd00:ec2::254`), multicast and reserved addresses,
including IPv4 addresses carried in NAT64, 6to4 and IPv4-compatible IPv6, and
ignores `HTTP_PROXY`/`HTTPS_PROXY` (a proxy would resolve the target itself,
past that check).

## Verification

The native Rust tests cover SQL escape denial, isolated databases, read-only
routes, cancellation and rollback, real ZIPP commit/rollback semantics,
migration checksums/atomicity, operator ownership/grants, fail-closed readiness,
crypto envelopes, timezone gaps/folds, and photo orientation/metadata/animation
handling. Test each application's actual packaged handlers through native HTTP
using disposable development data, including concurrency, upload limits and
authorization. Keep external delivery workers disabled for integration tests.
