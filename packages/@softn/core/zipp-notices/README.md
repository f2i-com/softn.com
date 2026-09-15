# Curated ZIPP third-party notices

ZIPP's web-python release bundle ships `LICENSE-APACHE` but no notices for the
code it compiles in from elsewhere: the RustPython parser (MIT) and the Unicode
data (Unicode licence). SoftN redistributes that engine, so it ships those
notices itself.

`THIRD_PARTY_LICENSES.txt` is the file `scripts/build-zipp-wasm.mjs` writes
(its `THIRD_PARTY_LICENSES.txt` step), generated from zipp.org's
`crates/rustpython-parser-fork/LICENSE` and `LICENSE-UNICODE`. Both are present
at tag `v0.0.18` (commit `fc474d15758827770f06d0dc2ebfe3055ebaa625`), and
regenerating the file from them there gives these bytes exactly.

`scripts/fetch-zipp-release.mjs` installs this copy beside the engine when the
release bundle has no `THIRD_PARTY_LICENSES.txt` of its own, and records it in
`wasm-zipp/SOURCE.json` as `notices.source: "softn-curated"` with its digest.
`npm run licenses:check` warns while that is so: a curated file cannot prove
itself complete against ZIPP's real dependency graph. Once a ZIPP release ships
the notices in its bundle, the install takes those instead
(`notices.source: "zipp-release"`) and this copy is no longer used.

When a new ZIPP release changes what it compiles in, regenerate this file from
that tag's sources and reinstall (`npm run fetch:zipp`); `--check` refuses an
install whose notices are not this file.
