## SoftN RELEASE_TAG

### What's new

<!-- changelog -->

### Downloads

<!-- downloads -->

The backend download targets Linux x86-64 with Apache/PHP and process execution enabled. It is a generic, unconfigured distribution: install your own public and private app bundles and preserve existing configuration, keys and databases when upgrading. Native XDB synchronization remains a Rust-host feature.

The complete website archive's name carries the tag of the zipp engine inside it. It ships no
example apps: the directory starts empty, and `.softn` files dropped on any
page of the site publish into it — one, or a folder at once, with the admin
key from `data/config.json` lifting the hourly limit for the site owner. The
example apps are published as `.softn` downloads with every
[softn-Examples release](https://github.com/f2i-com/softn-Examples/releases).
The desktop loader and builder are not attached to releases; they build from
this tag's manifests with `npm run tauri build` in their apps. `RELEASE-GUIDE.md`
below compares every download and says which one to take.

The single-app archive includes a small counter example; replace it with your own bundle. It has no app download controls, but browser-delivered app bytes remain extractable. Required license notices are included in all archives.
