import { expect, it } from 'vitest';
import { PLACEHOLDERS, assetTags, sampleBundle, shellTemplate } from '../scripts/shell.mjs';
import { unzipSync } from 'fflate';

const built = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Application</title>
    <script type="module" crossorigin src="./assets/index-CQU_ymBb.js"></script>
    <link rel="modulepreload" crossorigin href="./assets/core-Bx1.js">
    <link rel="stylesheet" crossorigin href="./assets/index-AvXQ3nb8.css">
  </head>
  <body><div id="root"></div></body>
</html>`;

it('lifts exactly the entry tags out of the built page', () => {
  const tags = assetTags(built);
  expect(tags).toContain(
    '<script type="module" crossorigin src="./assets/index-CQU_ymBb.js"></script>'
  );
  expect(tags).toContain('<link rel="modulepreload" crossorigin href="./assets/core-Bx1.js">');
  expect(tags).toContain('<link rel="stylesheet" crossorigin href="./assets/index-AvXQ3nb8.css">');
  expect(tags).not.toContain('<title>');
});

it('refuses a page without an entry script', () => {
  expect(() => assetTags('<html><head></head></html>')).toThrow();
});

it('writes a template with every placeholder index.php fills and the boot JSON before the entry', () => {
  const html = shellTemplate(assetTags(built));
  for (const placeholder of PLACEHOLDERS) expect(html).toContain(placeholder);
  expect(html.indexOf('id="softn-boot"')).toBeLessThan(html.indexOf('type="module"'));
  expect(html).not.toMatch(
    /\{\{(?!LANG|THEME|BACKGROUND|FOREGROUND|DESCRIPTION_TAG|TITLE|ICON_TAG|THEME_COLOR|PWA_TAGS|BOOT_JSON|LOADING_TEXT)[A-Z_]+\}\}/
  );
  expect(html.indexOf('{{PWA_TAGS}}')).toBeLessThan(html.indexOf('<style>'));
});

it('ships a sample whose event handler and state are in the bundle', () => {
  const files = unzipSync(sampleBundle());
  const logic = new TextDecoder().decode(files['logic/main.logic']);
  expect(logic).toContain('let sampleClicks = 0');
  expect(logic).toContain('function increment()');
  expect(JSON.parse(new TextDecoder().decode(files['manifest.json'])).main).toBe('ui/main.ui');
});
