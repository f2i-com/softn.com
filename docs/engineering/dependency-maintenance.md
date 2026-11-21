# Dependency maintenance

CI runs on pushes to `main` and on pull requests, and by hand
(`.github/workflows/ci.yml`); to check a dependency change locally first:

```sh
npm ci
npm test
npm run build:site
npm run licenses:check
npm audit
cargo test --locked --no-default-features --manifest-path crates/softn-xdb/Cargo.toml
cargo test --locked --manifest-path apps/softn-host-rust/Cargo.toml
cargo test --locked --manifest-path apps/softn-loader/src-tauri/Cargo.toml
cargo test --locked --manifest-path apps/softn-builder/src-tauri/Cargo.toml
node apps/softn-runner/build.mjs
(cd apps/softn-runner/host && cargo test --release --locked)
```

On Windows, also
`cargo test --locked --manifest-path apps/softn-loader/shell-extension/Cargo.toml`.

The native runtime and backend build on the XDB crate in `crates/softn-xdb`
(its notes are in [xdb/](xdb/README.md)). The crate has a lockfile of its own,
for its own tests, and each of the two apps resolves it again in theirs, so
moving one of its dependencies means updating three lockfiles: the crate's,
the loader's and the backend host's. libp2p 0.57 supplies the patched
GossipSub, Hickory, and Yamux networking dependencies.

Local models run on ZIPP's own model stack, vendored as source in
`packages/@softn/core/vendor/zipp-models/` rather than installed from npm.
Update it with `node scripts/vendor-zipp-models.mjs --zipp <checkout>` in that
package, which copies the files at the declared ZIPP release (the `zipp-vm`
tag in `apps/softn-host-rust/Cargo.toml`; `--ref <tag>` names another) byte for byte,
checks the GPU runtime against the release's embed kit when the kit is cached,
and records every file's digest in `SOURCE.json`; `--check` (and the licence
inventory) refuse a tree that differs from it.

The two GTK desktop dependency trees use the reviewed GLib 0.18.5 backport in
[vendor/README.md](../../vendor/README.md), and so does the XDB crate's own
lockfile, which carries Tauri for the crate's default feature. The backport's
release-mode Linux regression test must pass when that source changes.
Preserve its provenance and license when updating or removing it.

## Temporary picomatch override in v0.0.47

Vite, Vitest and the source tooling resolve `picomatch` to the exact
`@ryotsu/picomatch@4.0.7-a` tarball in the lockfile. Upstream 4.0.7 has a
high-severity parser advisory. The fork simplifies supported repeated wildcard
groups and treats unsupported complex forms as literals. Keep its default
parser safeguards enabled. [Upstream advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
· [Reviewed fork commit](https://github.com/ryotsu-kankichi/secured-picomatch/commit/3ab5a7627d480259e3d9ca67fbc14c125d374f0e)

Track advisories for the upstream package while the alias is in use. When
upstream publishes a patched release, remove the override, refresh the lockfile,
and run the dependency checks above and the browser suite.
