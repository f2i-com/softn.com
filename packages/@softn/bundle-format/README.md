# @softn/bundle-format

The `.softn` bundle contract shared by every SoftN surface: the archive
reader, the inspector, the `permission.json` declarations and the
page-to-page hand-off. No engine, no React, one dependency (`fflate`).

- `@softn/core` re-exports these modules under its previous paths
  (`@softn/core` root, `@softn/core/bundle`, `@softn/core/runtime`) and inlines
  the package into its published build, so consumers of core see no change.
- `@softn/site` imports them directly instead of keeping copies.

A change here changes the contract: keep every existing `.softn` file
opening exactly as before, and add a test that pins the behaviour.

`npm test -w @softn/bundle-format` runs this package's own tests: archives
no writer produces (`test/zip-hostile.test.ts`, written with the byte-level
writer in `test/craft.ts`), the inspector against the directory's limits, and
the declaration schema. The reader's other tests are core's
(`packages/@softn/core/test/bundle-*.test.ts`), which import these modules
through core's paths.
