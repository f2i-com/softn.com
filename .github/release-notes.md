## SoftN RELEASE_TAG

### Downloads

| File | What it is |
|------|------------|
| `softn-com-RELEASE_TAG-zipp-*.zip` | The complete static softn.com: the directory, the web runtime, Studio, Builder and the demo apps. Upload its contents to a web host's document root; `DEPLOY.md` inside explains the rest. The `.sha256` beside it is its checksum. |

The archive's name carries the tag of the zipp engine inside it. The desktop
loader and builder are not attached to releases; they build from this tag's
manifests with `npm run tauri build` in their apps.
