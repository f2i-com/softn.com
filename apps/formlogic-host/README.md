# FormLogic hosted app runtime

This trusted shell renders a SoftN bundle inside FormLogic's sandboxed, opaque-origin iframe.
The parent retains authentication and connects named backend actions through a MessageChannel.

## Engine handoff

The shell announces `formlogic:ready` with the ZIPP version and SHA-256 from the core package's
`wasm-zipp/SOURCE.json`. FormLogic checks both values against its own vendored release before
initializing the app. The `formlogic:init` message supplies the bundle, app ID, theme, channel
port and `zippWasm` ArrayBuffer. The shell configures that source before rendering SoftN.

FormLogic performs one lazy, checksum-verified engine download per page. Its expression worker
and every hosted app receive cloned bytes; they never share a mutable WASM instance, memory,
guest engine or permission configuration. Bytes also work across an opaque iframe boundary,
where posting a compiled WebAssembly.Module can fail asynchronously with `messageerror`.
Never transfer the parent's cached buffer, because that would detach it for later consumers.

The hosted shell explicitly uses main-thread script execution. Its restrictive CSP and opaque
origin do not currently permit SoftN's additional URL-based sandbox workers; forwarding engine
bytes does not grant permission to create those workers or enable additional host APIs.

## Updating

Vendor the same complete ZIPP release (WASM, generated glue, declarations and SOURCE.json) in
SoftN and FormLogic. From FormLogic's `formlogic/ui` directory, run:

```sh
npm run build:hosted-runtime
npm run test:zipp-sharing
npm run build
```

The builder produces the hosted shell from this checkout and checks engine identity. Deploy
the parent UI and generated `public/hosted-runtime` assets together. The browser integration
check exercises both loading orders, concurrent startup, retry, stale-shell rejection, separate
app state and a local backend action without contacting an account or live API.
