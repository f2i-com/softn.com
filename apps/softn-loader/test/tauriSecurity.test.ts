import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const tauriDir = resolve(__dirname, '../src-tauri');
const readJson = (path: string) => JSON.parse(readFileSync(resolve(tauriDir, path), 'utf8'));

function directive(csp: string, name: string): string[] {
  const found = csp.split(';').map((part) => part.trim().split(/\s+/)).find(([key]) => key === name);
  expect(found, `${name} is missing from the CSP`).toBeDefined();
  return found!.slice(1);
}

describe('what the desktop webview may reach', () => {
  it('gives desktop page script no file system plugin; Android keeps what reads a content URI', () => {
    // The desktop reads bundles through its own commands. plugin-fs there let
    // page script read the app-data folder: every app's database and its
    // pre-upgrade snapshots.
    const desktop: string[] = readJson('capabilities/default.json').permissions;
    const android: string[] = readJson('capabilities/android.json').permissions;
    expect(desktop.filter((permission) => permission.startsWith('fs:'))).toEqual([]);
    expect(android).toEqual(expect.arrayContaining(['fs:default', 'fs:allow-read-file']));
  });

  it('keeps connect-src narrow, since a bundle\'s requests are made natively', () => {
    const csp: string = readJson('tauri.conf.json').app.security.csp;
    const connect = directive(csp, 'connect-src');
    // No scheme-wide source: softn.net.fetch and remote imports go through
    // net_fetch, which enforces the grant.
    for (const wide of ['https:', 'http:', 'ws:', '*']) expect(connect).not.toContain(wide);
    // What cannot go native: model downloads and a development sync server.
    expect(connect).toEqual(expect.arrayContaining(['https://huggingface.co', 'https://*.hf.co', 'ws://localhost:*', 'wss:']));
    // Remote images are judged by the renderer's egress policy (consent,
    // net, allowed_hosts) before a URL reaches the page.
    expect(directive(csp, 'img-src')).toContain('https:');
    expect(directive(csp, 'script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"]);
  });
});
