/**
 * An app's CSS styles the app and nothing else.
 *
 * A bundle's `<style>` used to go into the host's document as written, and a
 * `<style>` applies to the whole document: `.softn-consent-bar { display:
 * none }` hid the permission bar while the app ran with everything withheld.
 * The renderer now puts every rule under the app's own element
 * (packages/@softn/core/src/loader/scope-css.ts), and has the browser read
 * the result back.
 *
 * The first test is the parser question, which only a real browser can
 * answer: a sheet written to make a CSS parser and the browser disagree
 * about where a rule ends, beside stand-ins for the host's elements, and
 * nothing outside the app may change. The second is the whole runtime: a
 * hostile app opened in /web/ next to the real permission bar, which must be
 * drawn exactly as it is for a harmless app, and stay on top.
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { pageBundle } from '../helpers/bundle';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** CSS written to escape the app, one sheet at a time. */
const HOSTILE = [
  '.softn-consent-bar{display:none!important}',
  'body{background:red!important;color:red} html{outline:5px solid red} :root{--host-color:red}',
  '.a{background:url(x{)} .host{display:none}',
  '.a{content:"x\n;} .host{color:red}',
  '[title="}"] .q{color:red} .host{opacity:0}',
  '/* .x */ .host /**/ {visibility:hidden}',
  '<!-- .host{color:red} -->',
  '.a{ :not(&){display:none} }',
  '.a{ :root:has(&) { background: red } }',
  'body{ & + *{display:none} & ~ *{display:none} }',
  'body{ :not(&) {display:none} }',
  '.a { @media (min-width:0px) { :not(&) { display:none } } }',
  '@scope (.host){ :scope{display:none} }',
  "@property --host-color{syntax:'<color>';inherits:false;initial-value:red}",
  '@starting-style{ .host{opacity:0} }',
  '@container (min-width:0px){ .host{color:red} }',
  '@media junk { .host {color:red} } @media (min-width:0px){} .host{color:red}',
  '@import url(x.css); @import "x.css"; @import/**/"x.css";',
  '.host{color:red!important}',
  '@font-face{font-family:"HostFont";src:local(Arial)}',
  '@keyframes host-anim{from{opacity:0}to{opacity:0}}',
  '@-webkit-keyframes host-anim{to{opacity:0}}',
  '@layer x{ .host{color:red} }',
  '.a{} } .host{color:red}',
  '*{display:none!important}',
  'body > *{color:red} :is(body) .host{color:red} :where(body) .host{color:red}',
  '& .host{color:red} & + .host{color:red}',
  '@media (min-width:0px){ .a{} } } .host{color:red}',
  '@supports selector(:has(a)) { .host{color:red} }',
  '.host, body{color:red}',
  '+ .host{color:red} ~ .host{color:red} > .host{color:red}',
  '.a{color:red',
];

const STAND_INS = `<!doctype html><html><head><style>
@font-face{font-family:"HostFont";src:local(Courier New)}
@keyframes host-anim{from{opacity:1}to{opacity:1}}
.host{color:rgb(1,2,3);font-family:HostFont,sans-serif;--host-color:rgb(4,5,6)}
#bar{color:var(--host-color);animation:host-anim 100s linear}
#bar::after{content:"Allow"}
</style></head><body>
<div class="softn-consent-bar host" id="bar">Bar</div>
<div class="host" id="h2">host</div>
<div data-softn-app="a1" style="display:contents"><div id="approot"><div class="a"><span class="b q" title="}">app</span></div></div></div>
<div class="host" id="h3">after</div>
</body></html>`;

/** What can be seen of everything outside the app, and the faces under the host's font's name. */
function outsideTheApp(): Record<string, string | number> {
  const props = ['display', 'visibility', 'opacity', 'color', 'background-color', 'outline-style', 'font-family', 'animation-name'];
  const out: Record<string, string | number> = {};
  const outside = [document.documentElement, document.body, ...document.querySelectorAll('body *')].filter(
    (el) => !el.closest('[data-softn-app]')
  );
  for (const el of outside) {
    const key = el.id || el.tagName;
    const cs = getComputedStyle(el);
    out[key] = props.map((p) => `${p}=${cs.getPropertyValue(p)}`).join(';');
    out[`${key}::after`] = getComputedStyle(el, '::after').getPropertyValue('content');
  }
  out.fonts = [...document.fonts].filter((f) => f.family.replace(/"/g, '') === 'HostFont').length;
  return out;
}

test('an app’s style block reaches nothing outside the app, however it is written', async ({ page }) => {
  const scoper = await build({
    stdin: {
      contents: `import { scopeAppCss } from './packages/@softn/core/src/loader/scope-css';
import { sanitizeBundleCSS } from './packages/@softn/core/src/loader/SoftNRenderer';
window.scope = (css) => scopeAppCss(sanitizeBundleCSS(css), 'a1').css;`,
      resolveDir: repo,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'error',
  });
  await page.setContent(STAND_INS);
  await page.addScriptTag({ content: scoper.outputFiles[0].text });
  const before = await page.evaluate(outsideTheApp);
  for (const css of HOSTILE) {
    const after = await page.evaluate(
      ([sheet, measure]) => {
        const style = document.createElement('style');
        style.textContent = (window as unknown as { scope: (css: string) => string }).scope(sheet);
        document.querySelector('#approot')!.appendChild(style);
        const seen = (0, eval)(`(${measure})`)();
        style.remove();
        return seen;
      },
      [css, outsideTheApp.toString()] as const
    );
    expect(after, `the host after ${JSON.stringify(css)}`).toEqual(before);
  }

  // And the app's own rules still style the app.
  const own = await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = (window as unknown as { scope: (css: string) => string }).scope(
      '.a{color:rgb(9,9,9)} body{background-color:rgb(7,7,7)} .a{ .b{color:rgb(8,8,8)} } @keyframes spin{to{opacity:.5}} .b{animation:spin 1s}'
    );
    document.querySelector('#approot')!.appendChild(style);
    return {
      a: getComputedStyle(document.querySelector('.a')!).color,
      root: getComputedStyle(document.getElementById('approot')!).backgroundColor,
      b: getComputedStyle(document.querySelector('.b')!).color,
      animation: getComputedStyle(document.querySelector('.b')!).animationName,
    };
  });
  expect(own).toEqual({ a: 'rgb(9, 9, 9)', root: 'rgb(7, 7, 7)', b: 'rgb(8, 8, 8)', animation: 'spin-a1' });
});

/** Open `buffer` through the workspace's "Open a .softn file" button. */
async function openBundle(page: Page, name: string, buffer: Buffer): Promise<void> {
  await page.goto('/web/');
  await expect(page.getByRole('heading', { name: 'Your app workspace', exact: true })).toBeVisible({ timeout: 60_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open a .softn file', exact: true }).click();
  await (await chooser).setFiles({ name, mimeType: 'application/octet-stream', buffer });
}

const HOSTILE_PAGE = `<!DOCTYPE html>
<html><head><title>Overlay</title><style>
.softn-consent-bar, .softn-consent-msg, .softn-consent-bar * { display: none !important; visibility: hidden !important; color: transparent !important; font-size: 0 !important }
.softn-runner-app { contain: none !important; isolation: auto !important; overflow: visible !important }
@font-face { font-family: "IBM Plex Sans"; src: local(Courier New) }
@keyframes softn-consent-fade-in { from { opacity: 0 } to { opacity: 0 } }
.cover { position: fixed; inset: 0; z-index: 2147483647; background: rgb(255, 0, 0) }
</style></head>
<body><div class="cover"></div><h1>Overlay app</h1></body></html>`;

const HARMLESS_PAGE = `<!DOCTYPE html>
<html><head><title>Overlay</title></head>
<body><div class="cover"></div><h1>Overlay app</h1></body></html>`;

/** How the permission bar is drawn, and whether it is what is under the pointer at its middle. */
async function theBar(page: Page) {
  const bar = page.locator('.softn-consent-bar');
  await expect(bar).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Overlay app' })).toBeAttached({ timeout: 60_000 });
  // After the bar's own fade-in.
  await page.waitForTimeout(600);
  return bar.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const drawn = (node: Element) => {
      const cs = getComputedStyle(node);
      return ['display', 'visibility', 'opacity', 'color', 'font-size', 'font-family', 'contain'].map((p) => cs.getPropertyValue(p)).join(';');
    };
    return {
      onTop: !!hit && el.contains(hit),
      bar: drawn(el),
      message: [...el.querySelectorAll('*')].map(drawn).join('|'),
      box: getComputedStyle(document.querySelector('.softn-runner-app')!).contain,
    };
  });
}

test('a hostile app cannot hide, reword or cover the permission bar', async ({ browser }, testInfo) => {
  const permissions = { net: { enabled: true, allowed_hosts: ['example.com'] } };
  /** The bar beside `html`, in a browser of its own, so the two apps never share a workspace. */
  const barBeside = async (name: string, html: string) => {
    const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      await openBundle(page, `${name}.softn`, pageBundle({ id: `softn-e2e-${name.toLowerCase()}`, name: 'Overlay', html, permissions }));
      return await theBar(page);
    } finally {
      await context.close();
    }
  };
  const harmless = await barBeside('Harmless', HARMLESS_PAGE);
  const hostile = await barBeside('Hostile', HOSTILE_PAGE);
  expect(harmless.onTop).toBe(true);
  expect(hostile).toEqual(harmless);
});
