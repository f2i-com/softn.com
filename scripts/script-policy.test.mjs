// The policy written into each app's built page (script-policy.mjs).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { inlineScripts, scriptPolicy, scriptPolicyPlugin } from './script-policy.mjs';

const THEME = "(function () { document.documentElement.setAttribute('data-theme', 'dark'); })();";
const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <script>${THEME}</script>
    <script type="application/ld+json">{"@type": "WebSite"}</script>
    <script type="module" crossorigin src="/web/assets/index-abc.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>`;

test('finds the inline scripts that run, and only those', () => {
  assert.deepEqual(inlineScripts(PAGE), [THEME]);
});

test('allows this origin, WebAssembly and each inline script by hash, and nothing inline besides', () => {
  const hash = createHash('sha256').update(THEME, 'utf8').digest('base64');
  const policy = scriptPolicy([THEME]);
  assert.equal(
    policy,
    `script-src 'self' 'wasm-unsafe-eval' 'sha256-${hash}'; object-src 'none'; base-uri 'self'; worker-src 'self' blob:`
  );
  assert.doesNotMatch(policy, /'unsafe-inline'|'unsafe-eval'/);
});

test('hashes a script as the browser reads it, with its line endings made LF', () => {
  const lf = "(function () {\n  document.title = 'x';\n})();";
  assert.equal(scriptPolicy([lf.replace(/\n/g, '\r\n')]), scriptPolicy([lf]));
});

test('is written first in the head, before any script it governs', () => {
  const out = scriptPolicyPlugin().transformIndexHtml.handler(PAGE);
  const meta = out.indexOf('http-equiv="Content-Security-Policy"');
  assert.ok(meta > 0 && meta < out.indexOf('<script'));
  // Once.
  assert.equal(scriptPolicyPlugin().transformIndexHtml.handler(out), out);
});
