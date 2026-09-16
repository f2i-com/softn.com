# FormLogic hosted app runtime

This trusted shell renders a SoftN bundle inside FormLogic's sandboxed, opaque-origin iframe.
The parent retains authentication and connects named backend actions through a MessageChannel.

## Engine handoff

The shell announces `formlogic:ready` with the ZIPP version and SHA-256 from the core package's
`wasm-zipp/SOURCE.json`. FormLogic checks both values against the engine it installed before
initializing the app. The `formlogic:init` message supplies the bundle, app ID, theme, channel
port and `zippWasm` ArrayBuffer. The shell configures that source before rendering SoftN.

`ready` also announces `engines`: the engine ids this document will accept, each with the bytes
it wants (`{"zipp-web-python": {version, sha256, release}}`). `init` may name one in `engine`;
absent means `zipp-web-python`, which is what hosted apps have always run, so a FormLogic that
knows nothing of either field behaves exactly as before. An engine this document does not serve
is refused by name rather than replaced, and the engine that loads must be able to run the
languages its id promises — `zipp-web-python` is checked for Python against the engine's own
profile, not against anyone's records. `hosted-runtime/runtime-manifest.json` names the same
engine ids in `engines` (with `features` for later runtime capabilities), read straight from
`src/engineInit.ts` so the manifest and this announcement cannot drift apart. The release
protocol is unchanged: `softn-release.json` gains nothing.

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
