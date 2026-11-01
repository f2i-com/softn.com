/**
 * The PHP-served single app reaches the browser with the same cross-origin
 * isolation the site sends for /play/<app>, from both places a host may
 * read it: the two .htaccess variants (with and without the backend) and
 * the PHP shell itself, for hosts that read no .htaccess (nginx, php -S).
 * The rule is read from the site's Apache config so none can drift.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

function apacheHeaders(config: string): string[] {
  return [...config.matchAll(/Header always set (Cross-Origin-(?:Opener|Embedder)-Policy) "([^"]+)"/g)].map(m => `${m[1]}: ${m[2]}`).sort();
}
function phpHeaders(source: string): string[] {
  return [...source.matchAll(/^header\('(Cross-Origin-(?:Opener|Embedder)-Policy): ([^']+)'\);/gm)].map(m => `${m[1]}: ${m[2]}`).sort();
}

describe('hosting headers', () => {
  const expected = apacheHeaders(read('../../../scripts/build/build-site.mjs'));

  it('the site sends the two isolation headers this test pins', () => {
    expect(expected).toEqual(['Cross-Origin-Embedder-Policy: credentialless', 'Cross-Origin-Opener-Policy: same-origin']);
  });

  it('both .htaccess variants send them', () => {
    expect(apacheHeaders(read('../public/.htaccess'))).toEqual(expected);
    expect(apacheHeaders(read('../htaccess-backend'))).toEqual(expected);
  });

  // PHP's copies land in the table `Header always` does not touch, so both went
  // out, and a browser ignores a policy it is given twice: on Apache the page
  // was not isolated. A real server is what shows it; this keeps the two lines.
  it.each(['../public/.htaccess', '../htaccess-backend'])('%s takes off what the shell sent before it sets its own', (file) => {
    const config = read(file);
    for (const name of ['Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy']) {
      const off = config.indexOf(`Header unset ${name}\n`);
      expect(off, `${file} unsets ${name}`).toBeGreaterThan(0);
      expect(off).toBeLessThan(config.indexOf(`Header always set ${name}`));
    }
  });

  it('the shell sends them itself, before any output', () => {
    const shell = read('../php/softn-serve.php');
    expect(phpHeaders(shell)).toEqual(expected);
    // Set with the other always-on headers at the top, not inside a route.
    const at = shell.indexOf("header('Cross-Origin-Opener-Policy");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(shell.indexOf('const SOFTN_COOKIE'));
  });
});
