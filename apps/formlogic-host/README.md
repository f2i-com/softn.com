# FormLogic hosted app runtime

This trusted shell renders a SoftN bundle inside FormLogic's sandboxed, opaque-origin iframe.
The parent retains authentication and connects named backend actions through a MessageChannel.

## Engine handoff

The shell announces `formlogic:ready` with the ZIPP version and SHA-256 from the core package's
`wasm-zipp/SOURCE.json`. FormLogic checks both values against the engine it installed before
initializing the app. The `formlogic:init` message supplies the bundle, app ID, theme, channel
port and `zippWasm` ArrayBuffer. The shell configures that source before rendering SoftN.

`ready` also announces `engines`: the engine ids this document will accept, each with the bytes
it wants (`{"zipp-web-python": {version, sha256, release}}`), or `true` where it wants none.
`init` may name one in `engine`; absent means `zipp-web-python`, which is what hosted apps have
always run, so a FormLogic that knows nothing of either field behaves exactly as before. An
engine this document does not serve is refused by name rather than replaced, and the engine that
loads must be able to run the languages its id promises — `zipp-web-python` is checked for Python
against the engine's own profile, not against anyone's records.
`hosted-runtime/runtime-manifest.json` names every engine the build serves in `engines` (with
`features` for later runtime capabilities), read straight from `src/engineInit.ts` so the
manifest and these announcements cannot drift apart.

## Theme

`init.dark` is FormLogic's own theme, and an app whose project declares none is drawn in it, as
it always was. A project whose manifest declares `config.theme.mode` `"light"` or `"dark"` is
drawn on that side whatever `dark` says, as it is in the web runtime, on a single-app page and in
the desktop app; a page's own `<App theme>` wins over both, and `"system"` follows `dark`
(`src/appTheme.ts`; the rule is `@softn/components`' `app-theme.ts`). The frame is the app's
whole document, so the side is written on the document: its tokens, and the body's ground and
text colour with them.

## Two documents

`index.html` serves the ZIPP engines. `host.html` is the same file with one attribute —
`<html data-softn-logic-engine="host-js">` — and serves only `host-js`, which runs the app
author's `.logic` as this document's own JavaScript with no VM around it.

It is a second document rather than a flag because of the Content-Security-Policy. The shell
writes its policy as a `<meta>` element before it accepts anything from the parent, and a meta
policy can be tightened afterwards but never relaxed. `host-js` needs `'unsafe-eval'` in
`script-src`; `index.html` must not have it and could not drop it later if it did. So the shell
reads the attribute first, `src/framePolicy.ts` turns the engines that document serves into the
policy, and the only difference between the two strings is that one token.

Each document serves exactly what it announces: a `host-js` `init` on `index.html` and a ZIPP
`init` on `host.html` are both refused by name. `host-js` needs no `zippWasm` bytes. The engine
itself is `@softn/core/host-js`, imported by `src/hostEngine.ts` — the host entry, which refuses
unless this really is the host document and the frame really has an opaque origin, and which
`index.html` never loads. What contains host JavaScript is the frame, not the adapter: read the
adapter's own header before turning it on.

The release protocol grows one key: `softn-release.json` `protocols.hostedEngines`, which says
how many hosted-runtime entry documents a reader has to understand.

FormLogic performs one lazy, checksum-verified engine download per page. Its expression worker
and every hosted app receive cloned bytes; they never share a mutable WASM instance, memory,
guest engine or permission configuration. Bytes also work across an opaque iframe boundary,
where posting a compiled WebAssembly.Module can fail asynchronously with `messageerror`.
Never transfer the parent's cached buffer, because that would detach it for later consumers.

The hosted shell explicitly uses main-thread script execution. Its restrictive CSP and opaque
origin do not currently permit SoftN's additional URL-based sandbox workers; forwarding engine
bytes does not grant permission to create those workers or enable additional host APIs.

## Backend calls and errors

`softn.backend.call` goes to the parent over the transferred port as
`{type:'call', id, action, input}`; the parent answers `{id, result}`. The
shell keeps four calls in flight and up to thirty-two waiting behind them
(`src/backendQueue.ts`), sending each as a slot frees, with a thirty-five-second
deadline from the moment a call is sent: longer than the twenty-five seconds
FormLogic lets a native app's request run, so a write that was made is not
answered as a failure the app may try again. A thirty-third waiting call, a
deadline and a reply the port could not deserialise (`messageerror`) each
resolve to `{error}` with a sentence that says which. A deadline answers the
app but does not free the slot: the parent holds four calls at a time with no
deadline of its own and refuses a fifth, so a slot is freed only when the
parent answers that call, or the port fails. A call still waiting for a slot
thirty-five seconds after it was made answers that it timed out.

A native app's `softn.net.fetch` is answered by the frame itself
(`src/nativeFetch.ts`): it sends `nativeRequest` with the URL and the options,
its method upper-cased as a browser's `fetch` sends it, and the parent routes
it to the app's own backend. Nothing is added to the app's source; until
v0.0.28 a JavaScript app had a `<logic>` fragment prepended to its entry file,
which ran after its helper files, so a helper that fetched as it loaded was
refused.

The shell is a public
URL: anyone may embed it and drive it with their own `formlogic:init`, and
gets only their own files running in an opaque frame against a port they
supplied; no FormLogic state is reachable from it.

## Media and seed data

An app's `assets/` arrive in `init.assets` as base64 and are served to the page as `data:` URLs
(`src/media.ts`): pictures (PNG, JPEG, GIF, WebP, AVIF, ICO, BMP, SVG, HDR, EXR), sound (MP3,
WAV, Ogg, Opus, AAC, FLAC, M4A), video (MP4, WebM), fonts (WOFF, WOFF2, TTF, OTF), 3D models
(glTF and GLB with their `.bin`, OBJ, STL, FBX), and WGSL shaders, text and Markdown to read,
each under the type core's asset classification gives it. Nothing that runs (HTML, JavaScript)
or styles the page is served. `connect-src` names `data:` so an app can `fetch` its own assets,
as a model loader or a compute shader does; that reaches no network.

The `.xdb` files `manifest.files.xdb` names are the app's seed records. Before it first draws,
the frame adds them to the app's database with core's reader and seeder (`src/seed.ts`), as SoftN
Web, the standalone runtime and the desktop loader do: once per record, never over a record the
person has, and a seed the person removed stays removed. A file that is missing, unreadable or
too large for the app's storage is named in the console and skipped; the app opens with the rest.
For a native app the seed is saved through the storage below, so it is held to its limits.

## App storage

A native app's (`init` with `native: true`) `localStorage` is a synchronous copy of the
snapshot `init` carries in `storage` (`src/storage.ts`). Each change goes to the parent as a
`nativeStorage` call, one at a time and in order. How a save counts depends on the parent:

- A parent that sends `storageLane: true` in `init` takes saves apart from its four calls,
  so the frame sends them in a lane of their own (ids from 1,000,000,000 up, one at a time):
  a screen whose own calls fill the four slots and the thirty-two places behind them no longer
  has a save refused as busy. Without it saves go with the calls, as before, since a parent
  that counts them against its four would refuse more of them.
- `ready` announces `storageProtocol: 1`. A parent that sends `storageProtocol: 1` in `init`
  gets acknowledged storage: a save counts only when the reply is `{result: {saved: true}}`
  with no `error`, read from the reply's own data fields. Each save has one deadline, twenty
  seconds from when the app made it, waiting included. A save sent and not answered by then
  has an unknown outcome, and later saves throw `InvalidStateError` until the parent answers it
  or the app is opened again. At most 32 saves wait at once, and one save as sent is at most
  32,768 characters. While saves are pending the frame says so, and closing the page asks
  first where the browser lets a frame ask: not in a sandbox without `allow-modals`, which
  FormLogic's frame is, so there the frame's own notice is all that shows.
  XDB's `createAsync`, `updateAsync` and `deleteAsync` resolve when their own save is
  confirmed, and an import goes as one `batch` the parent must commit whole.
- A parent that does not (protocol 0) gets the storage it always had: a reply without `error`
  is a save, and one with `error` shows the failed-save alert. A save is an ordinary call there,
  so it waits with the app's other calls under their limits: with four slow calls in flight it
  can expire at the thirty-five-second waiting deadline, or be refused as busy when 32 are waiting,
  and then it is not sent and the alert shows. XDB cannot report a save there as made: its
  async writes update the records and then reject with `persistence-unsupported`, imports and
  restores are refused, its status is `degraded`, and closing the page asks first where the
  browser lets the frame ask (above).

`{type: 'formlogic:dispose'}` on the port, or the page going away for good (a `pagehide` that
does not keep it in the back/forward cache), ends the app: waiting saves and calls are
cancelled, an acknowledged save already sent is marked unknown, and the app is unmounted.

An error is reported to the parent as `{type:'error', reason, phase}`. `phase` is `load` when
the app did not open (the frame shows the same one-line reason in its place, or the renderer
shows why) and `runtime` when it failed after its first page was drawn: it is still on screen,
and the renderer shows what went wrong inside it, so a parent should not put a "could not
load" message over it. `reason` and `phase` are additions; a parent that reads only `type` sees
what it always did, and one that reads `phase` should take a missing one as `load`, which is
what frames before v0.0.28 meant.

Test the queue, the engine handshake, the protocol, the policy, media and seeding with
`node --test apps/formlogic-host/test/*.mjs`.

## Updating

SoftN installs the ZIPP release its `apps/softn-host-rust/Cargo.toml` names into the generated
`wasm-zipp/` (`npm run fetch:zipp`; the build hooks do it too), and FormLogic takes that same
install from the `zipp/` folder of `softn-formlogic-runtime-<tag>.zip`. `formlogic:ready` also names
`zipp.release`; FormLogic still compares only the version and SHA-256. From FormLogic's
`formlogic/ui` directory, run:

```sh
npm run build:hosted-runtime
npm run test:zipp-sharing
npm run build
```

The builder produces the hosted shell from this checkout and checks engine identity. Deploy
the parent UI and generated `public/hosted-runtime` assets together. The browser integration
check exercises both loading orders, concurrent startup, retry, stale-shell rejection, separate
app state and a local backend action without contacting an account or live API.
