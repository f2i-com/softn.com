# Validation report

Prepared 15 September 2026 for content version 1.0.0.

## What passed

- 30 generated HTML documents, including the documentation index.
- Approximately 12,906 words across article titles, summaries, body text, tables and code examples. This is a content count, not 30 separate long-form essays.
- 23 Node tests passed; zero failures, skips or cancellations.
- The content passed the shipped validator and an independent Python Draft 2020-12 JSON Schema validator.
- 2,150 local documentation, sitemap and asset links resolved to generated files in the static scan. Repeated navigation links are included in that count.
- 519 same-page anchors resolved to existing IDs. IDs were unique within each document.
- All 30 pages had one H1, one canonical, a description and parseable JSON-LD.
- Repeated builds produced identical article and manifest output.
- Existing homepage and root sitemap files were preserved by the build tests. An unmanaged documentation file was refused rather than overwritten.
- Renamed article routes removed only previously generated files. Unsafe output paths and symlink targets were refused.
- The Node preview-server test served documents with HTTP 200, redirected the slashless article route, and returned HTTP 404 for a missing article.

## Visual and interaction checks

The actual generated HTML and CSS were rendered in Chromium at 1440px desktop and 390px mobile widths. All 30 documents were checked at the mobile width without page-level horizontal overflow. Table and code overflow remain in their own scrollable containers. Desktop, mobile, article and dark-mode screenshots are included.

Mobile disclosure navigation opened and exposed the expected link targets. A JavaScript-disabled rendering retained article text and code. The dark system preference applied the dark palette. The optional search returned the expected permissions pages and Escape cleared the result view. Copy-code passed the displayed example text to the clipboard interface.

**Browser-test limitation:** managed Chromium policy blocked HTTP(S) navigation, including localhost. The visual checks therefore used `set_content` with the generated HTML and CSS. Search used the generated search index through an in-memory fetch/origin stub; clipboard was stubbed too. These checks verify rendering and interaction wiring, not real browser network navigation or operating-system clipboard permission. Actual HTTP route/status behaviour was tested separately with Node's fetch against the local preview server.

## Not tested or claimed

The source repositories were not successfully cloned. Deeper GitHub source files, the landing-page implementation and full host guides were not fetched. No SoftN application build, example execution in ZIPP/SoftN, private backend deployment, source audit or exhaustive API conformance check was run.

The React homepage integration was not compiled inside the existing SoftN site. Apache/Nginx snippets were not applied to a production server. Existing CDN redirects, packaging rules and service-worker behaviour need verification in the actual deployment. External source links were not all live-checked. No search-engine indexing or ranking outcome is claimed.

See `validation-results.json` for the static/browser summary and `test-results.txt` for the Node test output.
