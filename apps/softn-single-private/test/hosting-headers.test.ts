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
  const expected = apacheHeaders(read('../../../scripts/build-site.mjs'));

  it('the site sends the two isolation headers this test pins', () => {
    expect(expected).toEqual(['Cross-Origin-Embedder-Policy: credentialless', 'Cross-Origin-Opener-Policy: same-origin']);
  });

  it('both .htaccess variants send them', () => {
    expect(apacheHeaders(read('../public/.htaccess'))).toEqual(expected);
    expect(apacheHeaders(read('../htaccess-backend'))).toEqual(expected);
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
