import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PLACEHOLDERS, assetTags, releasePrivateFiles, sampleBundle, sampleConfig, shellTemplate } from '../scripts/shell.mjs';
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

it('gives a release private/ the samples and the built template, never what dist/private holds', () => {
  const shell = new TextEncoder().encode('<!doctype html>{{BOOT_JSON}}');
  const files = releasePrivateFiles(shell);
  expect(Object.keys(files).sort()).toEqual(['.htaccess', 'app.softn', 'serve.config.php', 'shell.html']);
  expect(files['shell.html']).toBe(shell);
  expect(new TextDecoder().decode(files['serve.config.php'])).toBe(sampleConfig);
  expect(new TextDecoder().decode(files['serve.config.php'])).toContain("'secret' => '',");
  expect(Object.keys(unzipSync(files['app.softn'])).sort()).toEqual(Object.keys(unzipSync(sampleBundle())).sort());
  expect(files['app.softn']).toEqual(sampleBundle());
  // Both release scripts build private/ from it and copy nothing else of dist/private.
  for (const script of ['package-single-private.mjs', 'package-private-single-php.mjs']) {
    const source = readFileSync(new URL(`../../../scripts/${script}`, import.meta.url), 'utf8');
    expect(source, script).toContain('releasePrivateFiles(');
    expect(source, script).not.toMatch(/privateDir:\s*join\(dist,\s*'private'\)/);
  }
});
