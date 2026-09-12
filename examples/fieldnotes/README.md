# Fieldnotes

A small, editable task-planning app that demonstrates a form writing a record,
followed by a dashboard reflecting the change. Every seeded task is fictional.

Add a task, choose its focus, mark it complete or reopen it, and filter the list.
The app requires no account, network connection, AI provider or optional permission.
The browser runtime stores tasks locally under the app's storage identity.
Builder Preview is a test environment; its interactions do not modify the
project's exported seed records. Edit seeds in Builder's Data view to ship them.

The interface lives in `ui/main.ui`; validation and record operations live in
`logic/main.logic`. The `tasks` collection has `title`, `lane` and `done` fields.
The layout adapts to a phone, and all task controls have accessible labels.

After editing the source, rebuild the public bundle from the repository root:

```sh
node examples/fieldnotes/build.mjs
```

Open `apps/softn-site/public/examples/Fieldnotes.softn` in Builder or the runtime.
Exporting the project from Builder preserves the editable source and collection
schema. Browser runtime records remain local data; exporting source does not
automatically include records created in a runtime session.

With the development stack running on port 1420 and Playwright installed, run:

```sh
node examples/fieldnotes/check.mjs
node examples/fieldnotes/check.mjs --capture
```

`BUILDER_URL` and `RUNTIME_URL` override the local app addresses.
`PLAYWRIGHT_MODULE` can point to an existing Playwright module using a file URL.
The check uses disposable browser storage and serves this exact bundle to the
running apps. It verifies validation, creating and completing tasks, filtering,
runtime persistence after reload, isolated preview edits, Data edits reaching
preview, source/schema preservation on export and mobile overflow. Save uses
the browser-download fallback; this check does not operate a native file picker.

The homepage embeds this same bundle as a live, interactive app. Its runtime
entry (`/web/?preview=fieldnotes`) uses a temporary, memory-only database; adding
or completing tasks there never changes the visitor's saved Fieldnotes tasks.
Switching the homepage tabs keeps those demo edits, while reloading resets them.
The separate **Open in runtime** button opens the full app with normal local
storage. The embedded app shows a scaled desktop view on wide screens and its
responsive phone layout in narrow cards.

The **Data collections** tab uses `workspace-data.png`, an actual Builder
screenshot in `apps/softn-site/src/assets`, captured at 1440 × 1100 CSS pixels
(2160 × 1650 image pixels). Its five tasks are the fictional records in
`build.mjs`, with no account or personal data.

License: Apache-2.0, as in the repository's LICENSE and NOTICE.
