# Changelog

One section per release tag, newest first. The release workflow takes the
section for the tag being released and puts it at the top of the release
notes, above the downloads table; it refuses to package a tag that has no
section here. Write the section before tagging. Headings are the tag
(`## v1.2.3`); anything after the tag on the heading line is ignored.

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
