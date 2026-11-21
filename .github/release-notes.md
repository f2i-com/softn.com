## SoftN RELEASE_TAG

### What's new

<!-- changelog -->

### Downloads

<!-- downloads -->

The backend download targets Linux x86-64 with Apache/PHP and process execution enabled. It is a generic, unconfigured distribution: install your own public and private app bundles and preserve existing configuration, keys and databases when upgrading. Native XDB synchronization remains a Rust-host feature.

The complete website archive includes three editable web starters under `/examples/`.
Its filename identifies the bundled ZIPP version. The public app directory starts empty.
Drop an app archive or a folder of archives onto the site to publish. Site owners can
use the admin key from `data/config.json` to lift the hourly limit. The larger demo
catalogue is available with every
[softn-Examples release](https://github.com/f2i-com/softn-Examples/releases).
The desktop loader and builder are not attached to releases; they build from
this tag's manifests with `npm run tauri build` in their apps. `RELEASE-GUIDE.md`
below compares every download and says which one to take.

The single-app archive includes a small counter example; replace it with your own bundle. It has no app download controls, but browser-delivered app bytes remain extractable. Required license notices are included in all archives.
