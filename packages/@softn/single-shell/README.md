# @softn/single-shell

The shell that runs one `.softn` app on its own page, shared by the two
standalone hosts:

- `apps/softn-single` fetches `runtime.config.json` and the archive, and
  reads the bundle in the browser (`load.ts`).
- `apps/softn-single-private` is handed a source pack by `index.php` and
  fetches binary entries one by one; its loader lives in that app.

Both call `assembleApplication` (`assemble.ts`) once they hold the bundle's
text: the manifest read, the permission precedence (operator sidecar, then
`permission.json`, then a legacy manifest declaration, then nothing), the
source composition, the XDB seeding and the visitor's grant key are decided
there and nowhere else, so a bundle behaves the same on either host.

`SingleApp.tsx` renders the loaded app: the permission bar, the directory's
frame bar on a play page (in the site's theme), and the error boundary.
`config.ts` parses the deployment configuration and reads same-origin files
with a size bound.

Page mode is the third way in: a page of an author's own site, written as
SoftN, names `softn.js` first in its head (`apps/softn-single/public/softn.js`).
`page.ts` (`loadPageApplication`) fetches the page and the files it names from
beside it and assembles them as a bundle's text, through the same
`assembleApplication`; `headMetas.ts` carries the page's viewport,
theme-color and color-scheme metas into the document, which `softn.js` turned
into text with the rest of the head.

The bundle pipeline, the frame bar, the consent bar and the failure wording
are `@softn/runtime-shell`'s, shared with the web runtime and the desktop
loader, so the hosts open a bundle, and ask about it, the same way.
