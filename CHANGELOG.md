# Changelog

One section per release tag, newest first. The release workflow takes the
section for the tag being released and puts it at the top of the release
notes, above the downloads table; it refuses to package a tag that has no
section here. Write the section before tagging. Headings are the tag
(`## v1.2.3`); anything after the tag on the heading line is ignored.

## Unreleased

- The ZIPP engine is ZIPP's own v0.0.18 `web-python` release build, unchanged, instead of a local build: `npm run fetch:zipp` (`packages/@softn/core/scripts/fetch-zipp-release.mjs`, formerly `vendor:zipp-release`, which took the JavaScript-only bundle) installs it only after the bundle matches the release's `SHA256SUMS`, every file the bundle's own `SHA256SUMS`, and `BUILD-INFO.txt` and the module describe that release's web-python build. `SOURCE.json` records the release, both digests, the stack size and the notices' origin; `--check` verifies an install offline and `--check --online` against the published release. The engine is 8.2 MB raw (no wasm-opt) and 2.6% smaller with brotli.
- The RustPython and Unicode notices, which the release bundle does not carry, ship from a curated copy in `packages/@softn/core/zipp-notices/`; `licenses:check` names that in a warning and refuses anything but a verified release install.
- `softn-formlogic-runtime-<tag>.zip` carries the install unchanged under `zipp/` (with ZIPP's release `SHA256SUMS`), `softn-release.json` records the engine's whole `SOURCE.json`, and every copy of the engine in the archive, found by its exports, must be that release. A FormLogic that still vendors its own engine refuses this release; pin `SOFTN_RELEASE=v0.0.14` there.
- `build:zipp-wasm` builds an unreleased engine into `.cache/zipp-local/` for experiments; `fetch-zipp-release.mjs --install-local` installs it as a `local` build, which no release step accepts.
- Tests pin the Rust host's `zipp-vm` tag and its `Cargo.lock` commit to the installed release, and the engine to below the PWAs' Workbox precache cap.
- `packages/@softn/core/wasm-zipp/` is no longer committed. The build, test, typecheck and licence scripts install the ZIPP release that the `zipp-vm` tag in `apps/softn-host-rust/Cargo.toml` declares when the install is missing or another release (`fetch-zipp-release.mjs --ensure`, also an explicit step in every CI job that builds), so a commit builds against the same ZIPP in every job, and a new ZIPP release never changes an existing commit's result. A fresh clone needs network access, or `ZIPP_RELEASE_DIR`, the first time. `npm run fetch:zipp` without a tag installs the declared release; `--latest` only on request, and the next hook puts the declared release back unless `ZIPP_RELEASE` names another. Installs into one folder take turns under a lock file, so hooks started together cannot swap it under each other. `package:formlogic-runtime` installs it too before reading it.
- The release workflow's gate asks ZIPP for its latest release and refuses to ship unless that is the Cargo tag (`scripts/zipp-release-gate.mjs`); the `allow-older-zipp` dispatch input, or `[allow-older-zipp]` in the tag message, ships the declared release anyway (an older one, or a published pre-release) and the release notes say so. A dispatch retry works for tags from v0.0.15 on. The gate freezes the release and the digest of its `SHA256SUMS` for the verify, browser and packaging jobs; the packaging job checks the install against the published release again, requires `softn-release.json` to record that release, and names it in the release notes.
- The install lock names its holder (pid and a nonce), and a lock a killed install left is taken over by one waiter at a time (`.wasm-zipp.lock.break`), so hooks started together on it still install once; an install releases only its own lock, writes nothing once its lock is no longer its own, and on Windows tries again when a lock is refused for a moment while another is being deleted.

## v0.0.14

- Desktop runtime (loader): one owner per installation lifecycle. An upgrade, rollback or recovery holds an operation lease from its first precondition read to its last registry commit, a second operation on the same installation is refused, and finishing an upgrade is refused while a rollback or recovery holds the lease, so the registry can never describe a newer generation as active while an older snapshot is being written back. Registry writes carry a revision and a stale save is redone from a fresh read.
- Documentation pages wear the site's own product bar.
- Release workflow: a `skip-tests` option (dispatch input, or `[skip-tests]` in the tag message) ships a patch build without the verify and browser gates; the release notes say when it was used.

## v0.0.13

- A sixth release archive, `softn-formlogic-runtime-<tag>.zip`: the hosted
  frame, Builder and Studio as hosted editors, the native runtime and the
  starter adapter, already built, with a digest of every file in
  `softn-release.json`. FormLogic fetches the latest release instead of
  checking SoftN out and building it.
- The release archives each carry a plain-language `README.md` first, then
  their detailed guide; `RELEASE-GUIDE.md` on the release compares them.
- `@softn/bundle-format` and `@softn/editor-shared` share what the site, the
  editors and the runtime used to copy; every host reads manifests the same
  lenient way; sync-room security has one derivation; the PHP host follows
  the Rust host's route defaults; the directory API's owner routes answer
  CORS only for the site's own origin.
- The retired FormLogic bytecode VM is gone from `@softn/core`.
- Renamed archives, so the names say what they are (each archive's
  `README.md` and `RELEASE-GUIDE.md` say the old name too):
  `softn-com-<tag>-zipp-<engine>.zip` → `softn-website-<tag>-zipp-<engine>.zip`,
  `softn-single-<tag>.zip` → `softn-app-static-<tag>.zip`,
  `softn-single-php-linux-x64-<tag>.zip` → `softn-app-static-with-backend-linux-x64-<tag>.zip`,
  `softn-single-php-serve-<tag>.zip` → `softn-app-private-<tag>.zip`,
  `softn-private-single-php-linux-x64-<tag>.zip` → `softn-app-private-with-backend-linux-x64-<tag>.zip`.
- `apps/softn-single-php-serve` is now `apps/softn-single-private`
  (`@softn/single-private`), with its PHP in `php/` rather than `public/`;
  `npm run build:single-php-serve` and `package:single-php-serve` still work
  as aliases for one release. The guide is `docs/engineering/SINGLE_APP_PRIVATE.md`.
- The two backend hosts are named for what they are: `apps/softn-php` is now
  `apps/softn-host-php` (`@softn/host-php`; its `runtime/` files are unchanged
  byte for byte, so FormLogic's vendored copy still matches) and
  `apps/softn-rust` is `apps/softn-host-rust` (the crate and binary stay
  `softn-server`).

## v0.0.12

- Locally built ZIPP 0.0.18 with JavaScript and experimental Python support, recorded source provenance and matching runtime checksums. Existing reactive `.logic` screens continue to use JavaScript; Python is available through the engine host API.
- FormLogic-integrated Builder and Studio sessions, shared runtime loading, hosted draft review, and AI generation safeguards.
- Native SQLite record events for FormLogic automations, portable form modules, and improved hosted database editing guidance.
- Release packaging now includes locally built ZIPP provenance and Apache/Python notices without requiring an upstream release archive.
- Additional runtime lifecycle and language regression checks, plus updated build instructions and third-party notices.

## v0.0.11

- Verified ZIPP and editor integration.

## v0.0.10

- ZIPP 0.0.18 and the FormLogic integration.

## v0.0.9

- Tagged release.

## v0.0.8

- Tagged release.

## v0.0.7

- Website and single-app hosting distributions.

## v0.0.6

- Tagged release.

## v0.0.5

- Tagged release.

## v0.0.4

- Tagged release.

## v0.0.3

- Tagged release.

## v0.0.2

- Tagged release.

## v0.0.1

- First tagged release.
