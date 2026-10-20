# scripts/

The repository's own tooling: building, releasing, developing, and the checks
that hold the repository together. Run them through `npm run …` (the root
`package.json` names each one), which stays the same when a file moves.

| Folder | What is in it |
| --- | --- |
| `build/` | The site build (`build-site.mjs`, `npm run build:site`, `build:site:dev` with source maps), the PWA plugin and service worker (`pwa.mjs`, `pwa-sw.js`), what each app copies for core's workers (`core-worker-assets.mjs`), what is fetched on demand (`on-demand-chunks.mjs`), the source-map rule (`sourcemaps.mjs`), the script policy, and the precompressor. |
| `release/` | Packaging and releasing: the site, docs, single-app, private and FormLogic archives (`package-*.mjs`), the release notes and explainers, the ZIPP release gate, and the smoke checks a release runs. |
| `dev/` | Local development: every app at once (`dev-all.mjs`, `npm run dev`), the built site served as it is deployed (`serve-topology.mjs`, `serve-site.mjs`), the sync signalling server, the docs' dev plugin, and `clean.mjs` (`npm run clean`, which deletes every build output at once). |
| `brand/` | The brand mark and the icons drawn from it. |
| `licenses/` | The third-party notices and inventory (`generate-third-party-notices.mjs`, `npm run licenses:check`) and the licence texts it adds. |
| `demos/` | The example apps: pinning and fetching the softn-Examples release (`fetch-demos.mjs`), screenshots, and `softn-apps/`, the tooling for a folder of apps. |
| `checks/` | Tests that hold the whole repository to something — one ZIPP release, Python in every host, the host-JavaScript engine in one place, these folders — and the CI test sharding. |
| `lib/` | What the scripts share: the checkout's root (`paths.mjs`), the archive writer, build information, the engine-copy checks. |
| `bench/` | Performance measurement against a built site. |

Every script takes the checkout's root from `lib/paths.mjs`, so a script can
move between folders without its idea of the root moving with it.
`checks/script-paths.test.mjs` fails when a file still names a script by a
path it has left.
