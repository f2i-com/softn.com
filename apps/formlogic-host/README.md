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
(`src/backendQueue.ts`), sending each as a slot frees, with a twenty-second
deadline from the moment a call is sent. A thirty-third waiting call, a
deadline and a reply the port could not deserialise (`messageerror`) each
resolve to `{error}` with a sentence that says which. The shell is a public
URL: anyone may embed it and drive it with their own `formlogic:init`, and
gets only their own files running in an opaque frame against a port they
supplied; no FormLogic state is reachable from it.

A load failure is reported to the parent as `{type:'error', reason}` and
shown in the frame with the same one-line reason. `reason` is an addition;
a parent that reads only `type` sees what it always did.

Test the queue and the engine handshake with `node --test apps/formlogic-host/test/*.mjs`.

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
