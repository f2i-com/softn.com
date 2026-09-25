# Validation report

Edition of 25 September 2026, content version 1.1.0. It replaces the first
edition of 15 September 2026 (content version 1.0.0), which was drafted
from the public README without a checkout.

## How this edition was checked

Every guide was compared with the repository source, not with the README:
the working tree at commit `9ac48624ef62db7cc38fbb314865e1b64eaaee7c`, with
uncommitted changes, as recorded in the content's `review` block.

- Setup facts against `package.json` (Node `>=24.19.0`, scripts) and
  `scripts/dev-all.mjs` (the one origin, its proxied routes, port fallback,
  PHP only when `php -v` succeeds).
- The engine against `docs/engineering/ZIPP_LANGUAGES.md`, the `zipp-vm` tag
  in `apps/softn-host-rust/Cargo.toml` and the installed `SOURCE.json`
  (ZIPP v0.0.21, `web-python`, source revision `9df6e2fd…`).
- Python and torch against `packages/@softn/core/src/bundle/source-composer.ts`,
  `packages/@softn/bundle-format/src/inspect.ts`, the Python logic adapter and
  `examples/torch-trainer/`. Refusal messages are quoted from the composer.
- Event arguments and bindings against the renderer (`render.tsx`) and
  `vm-args.ts`: a handler bound by name receives a plain-data event (not null,
  as the first edition said), `@change`/`@input` the value, and `:bind` is the
  only two-way binding. The Python handler rule was confirmed against Studio's
  Python prompt in `apps/softn-studio/src/lib/agentOrchestrator.ts`.
- Builder labels (views, Create New App, the logic dock, file checks, handler
  suggestions, preview sizes, Export Bundle) against `apps/softn-builder/src`,
  and Studio labels (provider presets, brief, blueprint review, preview,
  validator, import/export, examples) against `apps/softn-studio/src`. Both
  apps were being changed while this edition was written; the guides describe
  the working tree on 25 September.
- `runtime.config.json` fields against `packages/@softn/single-shell` and
  `docs/engineering/SINGLE_APP_RUNTIME.md` (the `host` and `layout` fields are
  new in this edition), and archive names against the packaging scripts.

## What changed

31 pages (one new: Machine learning with torch). "JavaScript logic with ZIPP"
became "App logic in JavaScript or Python" and "JavaScript, Python and
compatibility" became "Python logic", both on their existing URLs; the Python
page moved from Capabilities to Language and data. Every page's `updatedAt`
is 2026-09-25.

## What passed

- `npm run docs:validate`: 31 pages, 12 sources, 6 navigation groups.
- `npm run docs:test` and `node --test docs/tests/*.test.mjs`: 25 tests, no
  failures. The page count in the tests moved from 30 to 31.
- `npm run docs:build`, and `npx vitest run` in `apps/softn-site` (17 files,
  122 tests), which checks `generated/landing.json` against the content.
- A static scan of the built pages: 2,223 local documentation links and 601
  same-page anchors, none broken.
- About 17,000 words across titles, summaries, body text, tables and code.

## Visual checks

The live pages were rendered in Chromium (Playwright) at 1366×900 and 390×844,
light and dark, with no page-level horizontal overflow. Changes made:

- The line under the search box is gone; its text is kept, hidden, as the
  message shown if the search index cannot load.
- The product bar comes from `@softn/brand`'s `bar.css`, which now fits all
  six links on a phone from about 320px up (the guides and the site both
  measured whole at 390px and 360px). For anything narrower, where the row
  still scrolls, the guides scroll the current page (Docs) into view and fade
  whichever end has more links (`docs.js`, `docs.css`).
- Tables no longer force a 26rem minimum width on a phone: two-column tables
  wrap, and tables of three or more columns become one card per row, each
  value labelled with its column.

## Not tested or claimed

Code samples follow the syntax the parser and composer accept but were not
each executed; Fieldnotes and the torch trainer are the runnable references.
ZIPP's website pages were not re-read after 15 September. No production
deployment, private backend or FormLogic host was exercised, Apache/Nginx
configuration was not applied to a server, and external links were not all
live-checked. No search-engine outcome is claimed.
