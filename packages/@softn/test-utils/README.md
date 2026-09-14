# @softn/test-utils

Test doubles shared across workspaces. Nothing in here ships.

- `fake-indexeddb`: enough of IndexedDB for the bundle hand-off and Studio's
  project records to run under Node — open with a version and an upgrade,
  object stores with out-of-line keys, get, put, delete, a forward cursor,
  and transactions that commit once no request is pending or abort on
  demand. Not a general IndexedDB; only what the tests need.

Import by package name (`@softn/test-utils/fake-indexeddb`) after listing it
under `devDependencies`; never by a relative path into another workspace.
