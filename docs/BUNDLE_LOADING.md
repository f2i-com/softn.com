# Bundle loading: the archive index and demand-read entries

How a `.softn` archive becomes the files an app reads, what is read when, and
what is deliberately not attempted. The reader is
`packages/@softn/core/src/bundle/zip.ts`; the hosts are
`apps/softn-web/src/lib/bundleProcessor.ts` (shared by softn-single) and the
worker pair `zipWorker.ts` / `zipWarmup.ts` beside it.

## What is eager, what is on demand

Opening a bundle (`readZip` in the hosts, `openBundleArchive` in core) does
two things at once:

- **The index.** The central directory is validated in full, before any entry
  is touched: the two EOCD entry counts must agree, ZIP64 is refused, only
  stored and deflate are accepted, a stored entry must declare one size, no
  entry may exceed 50 MB, no two entries may share a local header or a name,
  the compressed total must fit inside the file, the uncompressed total must
  fit under 500 MB, and every local header and payload must lie inside the
  file. Directory entries and names that could only be escapes (`/…`, `..`,
  NUL, `C:…`, `.` or empty segments) are dropped from the index. The index is
  small — a few fields per entry — and is what `names()`, `has()` and
  `declaredSize()` answer from.
- **Text entries** (`classifyAsset(path).binary === false`: `.ui`, `.logic`,
  `.xdb`, `.json`, `.gltf`, `.obj`, …) are read and decoded straight away,
  because the source composer needs all of them before anything renders; the
  host keeps the decoded string and `forget()`s the bytes, so a
  text-classified model (`.obj`, `.gltf`) of tens of megabytes costs its
  string, not its string and its bytes.

**Binary entries** (images, `.glb`, audio, video, fonts, and every unknown
extension) are only indexed. Each is inflated on the first read that asks for
it: an `asset(path)` from a template, the manifest icon, or the first-screen
warm-up below. The hosts expose them as `binaryFiles`, a `BundleBinaryStore`
shaped like the `Map<string, Uint8Array>` it replaced — `get`, `has`, `keys`,
`size`, `entries`, `forEach`, iteration — so a `Map` still stands in for it in
tests. `get` reads; `has`, `keys`, `size` and `declaredSize` come from the
index and read nothing; iterating reads everything, which is what iterating a
map of bytes always meant.

Every read, eager or on demand, goes through one code path: the entry is
charged to the running byte budget before its buffer is allocated, inflated
into a buffer of exactly its declared size, and refused unless its length and
CRC-32 match the central directory. `readBundleEntries(data)` — what the
inspector, the builder and the studio importer call — is literally
`openBundleArchive(data).readAll()`, so the eager readers and the demand-read
hosts cannot disagree about a header, a name, a size or a checksum.

### Consequence for a corrupt entry

Before, a bundle with one corrupt image failed to open, because every entry
was inflated at open. Now the open succeeds if its directory and its text are
sound; the corrupt image fails on the read that touches it, with the same
`Corrupt bundle: checksum mismatch for …` error, and resolves to no URL (the
asset resolver logs it once and answers `''` after). The bytes are never
handed on unverified in either design; what changed is when the refusal
lands. The bundle's identity (`computeAppOrigin`) is still a digest of all of
its bytes.

## The synchronous `asset()` contract, and why it is kept

App templates call `asset("images/x.png")` and use the result in the same
expression — `<Image src={asset("…")} />` — and the script runtime's `asset`
function is synchronous. Every shipped bundle depends on that, and the
handoff's compatibility constraint is that it keeps working unchanged.

So `asset(path)` remains synchronous: the resolver calls
`binaryFiles.get(path)`, which returns held bytes if the entry has been read
and otherwise inflates and verifies it right there on the main thread, then
mints an object URL once per path. A path the warm-up is still working on is
not waited for; the memo decides, and whichever side finishes first fills
it. Nothing blocks.

The way to make more of a large bundle lazy without a main-thread inflate is
the handoff's other branch: let host components accept an asynchronous asset
descriptor. That is a component-API change, out of scope here; the archive's
`warm()` and `BundleBinaryStore.isRead()` are what such a component would
build on.

## Memory model

- The archive keeps a reference to the bundle bytes (`data`) until
  `release()`, or until every entry has been produced once — held, forgotten
  since, or failed for good — when it drops the reference by itself
  (`compact()`, also callable; `compacted` reports it). For
  already-compressed media the bundle bytes are about the size of everything
  inflated from them, so holding both once everything is out was a second
  copy. The host holds those bytes for its own reasons (identity digest, the
  cache write) while it opens the bundle; they are freed after only if the
  host does not keep them.
- Bytes read are memoised per entry and not re-inflated unless `forget(name)`
  drops them, which refunds the held budget; while the archive still has the
  bundle bytes a later `read()` inflates the entry again, and after
  `compact()` it throws `Bundle archive compacted: <name> was forgotten and
  cannot be read again`. The memo is charged against the same 500 MB total
  the index already enforced on the declared total, so demand reads cannot
  exceed what an eager read could; the second check is defence in depth
  behind the first. `heldBytes()` reports what the memo currently costs. Text
  entries read at open are decoded and forgotten; `heldBytes()` is zero after
  `readZip` until the first binary read.
- A corrupt entry is remembered as such, so a renderer asking for a broken
  image on every frame does not inflate it on every frame. A rejected worker
  result is _not_ remembered against the entry: it says nothing about the
  archive's own bytes.
- `release()` drops the memo and the archive reference. The index survives,
  so `names()`, `has()` and `declaredSize()` still answer and a host can tell
  "never in the bundle" from "no longer held"; `read()`, `readAll()` and
  `warm()` throw `Bundle archive released`. The hosts release through the
  asset resolver: `createAssetResolver(...).dispose()` revokes its object URLs
  and then calls `binaryFiles.release()`, so the tab close in softn-web and the
  unmount in softn-single free the archive without further wiring. A warm-up
  still in flight sees the release at its next step and stops; its worker is
  terminated when the warm-up settles. `release()` works after `compact()`
  too; `released` becomes true and `compacted` false.

## The worker warm-up

`apps/softn-web/src/lib/zipWarmup.ts` runs after the source is composed and
before the app renders, without being awaited:

1. `firstScreenAssets` picks the paths: every `asset("…")` / `asset('…')`
   whose argument is a single string literal, in source order over the
   composed `.ui`/`.logic` text, then the manifest's `files.assets` in the
   manifest's order, keeping those the bundle holds as binaries and has not
   read yet (text-classified names, names not in the archive and duplicates
   contribute nothing). Dynamic arguments — `asset(path)`,
   `asset(base + name)` — contribute nothing by themselves; over the 28
   shipped bundles 6 of 16 `asset()` calls are literals, all in one bundle,
   so the manifest list is what reaches GFXX-Anika's 51 MB of media, and the
   author's order puts the first screen first; a manifest that lists only
   its icon (PromptlyUnemployed) gets only what it lists. The icon is not a
   candidate: both hosts extract it before they ask. The list is cut at the first path
   that would exceed **32 entries** or **64 MB declared** — bounds, not
   targets: more images than a first screen shows, more decoded bytes than a
   first screen can upload before the user has seen anything.
2. `warmFirstScreen` creates a module worker from app source
   (`new Worker(new URL('./zipWorker.ts', import.meta.url), { type: 'module' })`,
   the form Vite bundles; a URL built inside core's dist would point at a file
   no host serves). The worker receives **one copy** of the archive bytes —
   copied, not transferred, because the main thread keeps its own for
   synchronous reads — and is asked for a step's worth of names at a time
   (about 2 MB declared per step, `WARM_CHUNK_BYTES` in zip.ts). It runs
   `inflateEntries`, the same index and read as the main thread, and posts the
   bytes back with their buffers in the transfer list, so what it produced is
   moved, not copied.
3. `BundleArchive.warm` verifies every buffer that comes back against the
   central directory — length and CRC-32 — before keeping it, on the main
   thread. A worker is a peer, not an authority; wrong bytes reject the
   warm-up and leave the memo untouched. Verifying 2 MB costs a few
   milliseconds, which is why the steps are that size.
4. Where there is no `Worker` (tests, Node, a browser with workers disabled),
   or the worker fails to load, errors, or does not answer within 20 s, the
   warm-up carries on synchronously: the same steps, read on the main thread
   with a yield to the event loop between them. Abort (`abort()`, or the
   host releasing the archive) stops it at the next step and terminates the
   worker.

The worker script (`apps/softn-web/src/lib/zipWorker.ts`) imports the reader
from `@softn/core/bundle`, the `./bundle` entry in core's exports map, which
resolves to core's built `dist/bundle/zip.js` — a tsup entry of its own.
Through the `@softn/core` barrel the worker chunk measured 1.35 MB, yjs and
the engine glue included, because a bundler cannot tree-shake past core's
side-effectful chunks; by the entry it is about 11 kB, and the web
build-graph test caps it at 50 kB.

Marks on the performance timeline, for `scripts/bench/measure.mjs`:
`softn:zip` now covers indexing plus text extraction; `softn:asset-extract`
is emitted around each demand inflate on the main thread (a memo hit is not a
phase; the harness sums repeats); `softn:asset-warm` spans a warm-up that had
something to do.

## Parsed document reuse

Once the source is composed, it is parsed into one immutable document that
every stage shares. `parseCached(source)` in
`packages/@softn/core/src/parser/parse-cache.ts` keeps the last eight parsed
documents, least recently used out first, keyed by the source string itself
and the parser's `PARSER_VERSION` (exported from `parser.ts`; a change in
what `parse` returns for the same source must bump it). `SoftNWithXDB` asks
it for the document to find the `<data>` block, and the `SoftNRenderer` it
wraps asks for the same string and is handed the same object — one parse per
load where there were two, and one per source change where there were two
more. A hot-reload save that leaves the text as it was is a hit. A parse that
throws is not stored, so the next ask throws the same way.

What is shared is the document and the diagnostics on it. The VM and its
state, the XDB subscriptions and the permission checks are still made per
renderer instance from that document, in the order they always were; the
cache changes only where the document comes from.

Sharing is sound because nothing downstream writes into the tree. The audit
of `loader/`, `renderer/`, `runtime/` and `bundle/` found the renderer
writing only into objects it makes per render — the `props` it builds for
each element, the slot map, a `<collection>`'s query options — and copying a
node before it changes one (`{ ...node, inlineEach: undefined }` for an
inline `each`); the runtime reads `script.code` and never assigns to the
block; the data hook maps the collection list rather than sorting it. The
proof is `packages/@softn/core/test/ast-immutability.test.tsx`: it parses a
document with a component declaration, a data block, logic, `#if`/`#each`
and a registered host component, deep-freezes the very instance the cache
holds, and mounts it through `SoftNRenderer` and `SoftNWithXDB`, under
StrictMode and across a source change, clicking through a state change on
the way. Module code runs in strict mode, so any write into the frozen tree
would throw.

Marks: `softn:parse` still surrounds the lookup, hit or miss, so a profile
shows a shared parse as a phase of about zero milliseconds rather than a
missing one. `getParseCacheStats()` reports hits, misses and held entries.

Two other parse sites are separate and unchanged: `bundle/runtime.tsx` keeps
its own per-bundle `documentCache` for the `.ui` files it composes for
imports, and `useDynamicSoftN` parses the file it watches on disk. Neither
is on the render path above.

## What this does not change: downloaded bytes

The whole archive is still fetched, and digested, before any of the above
runs. Nothing here reduces bytes on the wire, and no host claims it does.

The reason is the integrity model. A bundle's identity — what its database,
its permission grants and its cached copy hang off — is a digest of the
complete archive, and every check above is made against a central directory
read from the complete archive. A partial fetch has nothing to verify a range
against. A future design that fetched entries on demand would need, per the
handoff: authenticated metadata (a manifest or sidecar signed or bound to the
bundle's identity), a hash per entry so a fetched range can be verified on its
own, correct HTTP range support and its failure modes, and a full-download
fallback for hosts and caches that cannot serve ranges — while keeping the
portable single-file archive as a supported interchange format. Until then,
the demand read saves inflate time and resident memory for the entries an app
does not touch, and — once every entry is out — the compressed archive
itself; that is all it saves.
