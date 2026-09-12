# README screenshots

Direct screenshots of the real SoftN Builder and Runtime, captured on
12 September 2026. The app is [Fieldnotes](../../examples/fieldnotes), using the
checked-in [bundle](../../apps/softn-site/public/examples/Fieldnotes.softn).
Its `.ui` is rendered by SoftN and its `.logic` runs on ZIPP.

| Asset | Pixels | View |
| :---- | :----- | :--- |
| `builder-preview.jpg` | 2160 × 1500 | Builder Preview, Fieldnotes in light mode with an unfinished task in the form. |
| `builder-data.jpg` | 2160 × 1500 | Builder Data, the task collection's schema and five sample records. |
| `app-dark.jpg` | 2160 × 1500 | The same bundle running in Runtime in dark mode. |
| `app-mobile.jpg` | 585 × 1266 | Runtime at 390 × 844 CSS pixels, dark mode, with the runtime bar hidden using its own control. |

## Reproduce

Build the shared packages and start the local site with `npm run dev`, then run
from the repository root:

```sh
node docs/readme-assets/capture.mjs
```

`BUILDER_URL` and `RUNTIME_URL` override the default addresses at
`http://localhost:1420/builder/` and `http://localhost:1420/web/`.

The script opens a fresh Playwright Chromium context, uses the actual checked-in
bundle and captures the visible page at device scale factor 1.5. It waits for
loaded fonts, the real app and the import notice to disappear. Images are JPEG
at quality 90, with animations disabled. No image is retouched or composited.

The capture also checks actual task creation/completion, updated totals,
preview isolation from exported seed records, the dark palette and mobile
overflow. All five starting tasks are fictional examples from
[`build.mjs`](../../examples/fieldnotes/build.mjs). The unfinished draft and test
tasks exist only in disposable browser storage. No account, AI provider or
connected FormLogic/OAIY session is used.

Refresh these images when Fieldnotes or the workspaces change. The screenshots
illustrate the app's real layout; its interactive source remains available in
the bundle and example directory.
