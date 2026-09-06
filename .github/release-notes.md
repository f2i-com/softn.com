## SoftN RELEASE_TAG

### Downloads

| File | What it is |
|------|------------|
| `softn-com-RELEASE_TAG-zipp-*.zip` | The complete static softn.com: the directory, the web runtime, Studio and Builder. Upload its contents to a web host's document root; `DEPLOY.md` inside explains the rest. The `.sha256` beside it is its checksum. |

The archive's name carries the tag of the zipp engine inside it. It ships no
example apps: the directory starts empty, and `.softn` files dropped on any
page of the site publish into it — one, or a folder at once, with the admin
key from `data/config.json` lifting the hourly limit for the site owner. The
example apps are published as `.softn` downloads with every
[softn-Examples release](https://github.com/f2i-com/softn-Examples/releases).
The desktop loader and builder are not attached to releases; they build from
this tag's manifests with `npm run tauri build` in their apps.
