# Curated ZIPP third-party notices

A ZIPP release (the engine SoftN ships is its javascript-python-base module)
ships `LICENSE-APACHE`, in its embed kit, but no notices for the code it
compiles in from elsewhere: the Unicode data (Unicode licence) behind its
identifier and character-name tables. SoftN redistributes that engine, so it
ships that notice itself. The same release's torch package (installed beside
the engine in `wasm-zipp-torch/`) is built from the same commit and likewise
comes with no notices of its own.

`THIRD_PARTY_LICENSES.txt` is the file `scripts/build-zipp-wasm.mjs` writes
(its `THIRD_PARTY_LICENSES.txt` step), generated from zipp.org's
`LICENSE-UNICODE`. It is present at tag `v0.0.26` (commit
`5f1c0578d6d6e4a8bc68d6108b67029782be5fe8`), unchanged since `v0.0.21`, and
regenerating the file from it there gives these bytes exactly.

Up to 0.0.20 the file also carried the RustPython parser's MIT licence. ZIPP
0.0.21 removed its RustPython fork and parses Python with its own
`crates/zipp-pyparse`, whose README states it contains no RustPython code, so
that notice no longer applies to the engine SoftN ships.

`scripts/fetch-zipp-release.mjs` installs this copy beside the engine when the
release's embed kit has no `THIRD_PARTY_LICENSES.txt` of its own, and records it in
`wasm-zipp/SOURCE.json` as `notices.source: "softn-curated"` with its digest.
`npm run licenses:check` warns while that is so: a curated file cannot prove
itself complete against ZIPP's real dependency graph. Once a ZIPP release ships
the notices in its embed kit, the install takes those instead
(`notices.source: "zipp-release"`) and this copy is no longer used.

When a new ZIPP release changes what it compiles in, regenerate this file from
that tag's sources and reinstall (`npm run fetch:zipp`); `--check` refuses an
install whose notices are not this file.
