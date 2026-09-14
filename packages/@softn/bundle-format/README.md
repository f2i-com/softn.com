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
