# Documentation

Two kinds of writing live here, and they are kept apart on purpose.

| Path | What it is | Who it is for |
| --- | --- | --- |
| `content/softn-docs.json` | **The guides softn.com publishes at `/docs/`**: thirty-one pages, from "What is SoftN?" to hosting, authored in one structured JSON file. The generator below turns it into static HTML. | People using SoftN |
| `engineering/` | Design notes, hosting recipes and audit responses for people working on this repository. Plain Markdown, linked from the root README. | Contributors |
| `rfcs/` | Proposals not yet implemented. | Contributors |
| `readme-assets/` | The screenshots the root README shows. | — |

## The published guides

`content/softn-docs.json` is the source of truth for every guide, the
navigation, the homepage cards and the source references. Do not keep a
second copy of any article text in JSX, Markdown or generated HTML.

```sh
npm run docs:validate   # schema and cross-reference checks
npm run docs:build      # writes docs/dist/ (ignored) and refreshes generated/landing.json
npm run docs:test       # the generator's own tests (also part of `npm test`)
npm run docs:preview    # build, then serve http://127.0.0.1:4173/docs/
```

What the generator writes:

- `docs/<slug>/index.html` for every page, each independently loadable and
  readable without JavaScript: one H1, section anchors, crawlable navigation,
  a unique title and description, a canonical URL, OpenGraph and JSON-LD.
  Nonexistent guides are real 404s on the hosts the site ships configuration
  for.
- `docs/search-index.json`, used only when a visitor opens the search box.
- `docs/_assets/docs-<hash>.css` and `docs-<hash>.js`: the stylesheet is
  `@softn/brand`'s `tokens.css`, the `@font-face` rules for the brand faces
  it copies into `docs/_assets/fonts/`, then `assets/docs.css`, so the
  guides are drawn from the same variables and type as the site, the
  runtime, Studio and Builder and follow the same stored theme choice
  (`softn.site.theme`). The header is the product bar the four apps share.
- `sitemap-docs.xml` beside the site's `index.html`; `scripts/build-site.mjs`
  writes a `robots.txt` that names it.
- `generated/landing.json`: a few kilobytes of card data for the front door
  (`apps/softn-site/src/components/LearnDocs.tsx` imports it). It is
  committed so a fresh checkout typechecks; `npm run build:site` regenerates
  it before the site build, and a test keeps it in step with the content.

How the site build uses it: `scripts/build-site.mjs` runs the generator
once before the site build (validation, fresh card data) and once more into
`dist/` after the site's own files are in place. The generator owns only the
files it wrote (`dist/.softn-docs-build.json` is its manifest) and refuses to
overwrite anything else, so it can never replace the landing page; the
packaging step ships `dist/` whole, guides included.

### Editing a guide

A page has a stable `id`, a URL `slug`, a `groupId`, a title and summary,
SEO metadata, an authored `updatedAt` (change it when the content changes:
it is the sitemap's `lastmod`), source IDs, sections and related pages.
Text is plain text with optional inline backticks for code, not Markdown.
Blocks: `paragraph`, `code`, `list`, `steps`, `table`, `callout`,
`definitions`, `links`, `cards`. Raw HTML and non-HTTP(S) links are rejected.
When adding a page, add it to exactly one navigation group; the validator
rejects missing references, duplicate routes, duplicate titles and unknown
fields.

`VALIDATION_REPORT.md` records how the current edition (25 September 2026)
was checked against the repository source, what passed and what was not
checked. The content's `review` block names the commit it was compared with;
when you revise a guide against newer source, update that block, the page's
`updatedAt` and its `sources` entries together.

## The engineering notes

| Note | Subject |
| --- | --- |
| `engineering/BUNDLE_LOADING.md`, `COMPONENT_LOADING.md`, `LOCAL_APP_REOPEN.md` | How bundles and components are loaded and reopened |
| `engineering/BUILDER_DATA.md` | Builder collections, relationships and record references |
| `engineering/SINGLE_APP_RUNTIME.md`, `SINGLE_APP_PRIVATE.md` | Hosting one app on its own, static or PHP-served (copied into those archives as `DEPLOYMENT.md`) |
| `engineering/DESKTOP_APPS.md` | The Tauri desktop apps and the shared bundle workflow |
| `engineering/FORMLOGIC_INTEGRATION.md` | The FormLogic starter adapter |
| `engineering/LOCAL_SPEECH.md`, `SCENE3D_*.md`, `ZIPP_LANGUAGES.md`, `zipp-memory-lifecycle.md`, `PERFORMANCE_MEASUREMENT.md` | Subsystem notes |
| `engineering/hosting-the-poker-authority.md` | Running the optional table authority the poker example uses |
| `engineering/dependency-maintenance.md` | Keeping the dependency graph current |
| `engineering/audits/` | Audit reports and the responses to them |
