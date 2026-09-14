/**
 * The self-hosted single app must reach the browser with the same
 * cross-origin isolation the site sends for /play/<app>: an app that uses
 * the CPU language-model provider (SharedArrayBuffer) would otherwise run
 * on one core here and on every core there. The rule is read from the
 * site's Apache config so the two cannot drift apart.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

function isolationHeaders(config: string): string[] {
  return [...config.matchAll(/Header always set (Cross-Origin-(?:Opener|Embedder)-Policy) "([^"]+)"/g)].map(m => `${m[1]}: ${m[2]}`).sort();
}

describe('hosting headers', () => {
  it('sends the isolation headers the site sends, and only those', () => {
    const site = read('../../../scripts/build-site.mjs');
    const expected = isolationHeaders(site);
    expect(expected).toEqual(['Cross-Origin-Embedder-Policy: credentialless', 'Cross-Origin-Opener-Policy: same-origin']);
    expect(isolationHeaders(read('../public/.htaccess'))).toEqual(expected);
  });

  it('keeps nosniff and no-store for the bundle and its config', () => {
    const htaccess = read('../public/.htaccess');
    expect(htaccess).toMatch(/Header always set X-Content-Type-Options "nosniff"/);
    expect(htaccess).toMatch(/<FilesMatch "\\\.\(softn\|json\)\$">\n\s*Header set Cache-Control "no-store"/);
  });
});
