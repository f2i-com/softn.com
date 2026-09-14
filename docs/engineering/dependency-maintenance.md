# Dependency maintenance

Run checks locally while automatic CI is paused:

```sh
npm ci
npm test
npm run build:site
npm run licenses:check
npm audit
cargo test --locked --manifest-path apps/softn-rust/Cargo.toml
cargo check --locked --manifest-path apps/softn-loader/src-tauri/Cargo.toml
cargo check --locked --manifest-path apps/softn-builder/src-tauri/Cargo.toml
```

The native runtime and backend use the sibling `xdb.org` checkout. Keep it
current when resolving the native lockfiles; libp2p 0.57 supplies the patched
GossipSub, Hickory, and Yamux networking dependencies.

Keep the explicit `@huggingface/transformers` nested overrides for `sharp` and
`onnxruntime-node`'s `adm-zip`. With npm 11.17, broad overrides alone retained
vulnerable nested resolutions. Check `npm ls adm-zip sharp --all` and a clean
`npm ci` after updating them; do not accept a lockfile with invalid resolutions.

The two GTK desktop dependency trees use the reviewed GLib 0.18.5 backport in
[vendor/README.md](../vendor/README.md). Its release-mode Linux regression test
must pass when that source changes. Preserve its provenance and license when
updating or removing it.
