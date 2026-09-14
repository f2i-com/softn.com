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
frame bar on a play page, and the error boundary. `config.ts` parses the
deployment configuration and reads same-origin files with a size bound.

The shell reads bundles through the web runtime's processor
(`apps/softn-web/src/lib/bundleProcessor.ts`); that module and the frame bar
are the runtime's, imported here so the three hosts open a bundle the same
way.
