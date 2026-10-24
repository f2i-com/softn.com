/** @vitest-environment jsdom */
/**
 * What the check says of a call it did not grant.
 *
 * A check grants no capabilities: there is nobody to ask. The runtime, asked
 * for storage or the network with nothing granted and no declaration handed
 * to it, says "this bundle ships no permission.json. Declare the
 * capabilities it needs", and the check passed that line to the model as it
 * stood. Studio writes a permission.json into every app, so for an app that
 * reads its storage as it starts the model was told, at every check, to
 * declare a file the project has, in words that say the file is missing.
 * The preview has always said the true thing in its own banner ("Preview
 * grants no capabilities: storage is declared…"); the check now does too.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerAllBuiltins } from '@softn/components';
import { configureZippWasmSource } from '@softn/core';
import { browserEnvironment } from '../src/lib/agent/appCheck';
import { explainUngrantedCalls } from '../src/lib/declaredCapabilities';
import type { VFSFile } from '../src/types/studio';

beforeAll(() => {
  configureZippWasmSource(readFileSync(resolve(process.cwd(), '../../packages/@softn/core/wasm-zipp/zipp_wasm_bg.wasm')));
  registerAllBuiltins();
});

const RUNTIME_LINE = (capability: string, op: string) =>
  `[SoftN] ${op} failed: Error: ${capability} access not permitted: this bundle ships no permission.json. Declare the capabilities it needs — { "permissions": { "${capability}": { "enabled": true } } } — so the user can see and approve them.`;

const DECLARES = (names: string[]) => JSON.stringify({ permissions: Object.fromEntries(names.map((name) => [name, { enabled: true }])) });

describe('a line of the runtime about a call that was not granted', () => {
  it('is said as what is true when the project declares that capability', () => {
    const out = explainUngrantedCalls([RUNTIME_LINE('storage', 'storage.op')], DECLARES(['storage']));
    expect(out).toHaveLength(1);
    expect(out[0]).not.toMatch(/ships no permission\.json/);
    expect(out[0]).not.toMatch(/Declare the capabilities/);
    expect(out[0]).toMatch(/storage/);
    expect(out[0]).toMatch(/already declares/);
    expect(out[0]).toMatch(/nothing to fix/i);
  });

  it('is said once for a capability, however many calls were refused', () => {
    const lines = [RUNTIME_LINE('storage', 'storage.op'), 'something else', RUNTIME_LINE('storage', 'storage.op'), RUNTIME_LINE('net', 'net.fetch')];
    const out = explainUngrantedCalls(lines, DECLARES(['net', 'storage']));
    expect(out).toHaveLength(3);
    expect(out[1]).toBe('something else');
    expect(out.filter((line) => /already declares storage/.test(line))).toHaveLength(1);
    expect(out.filter((line) => /already declares net/.test(line))).toHaveLength(1);
  });

  it('is left as the runtime said it when the project does not declare that capability', () => {
    // Here the runtime's advice is the right advice: the declaration is missing.
    const line = RUNTIME_LINE('net', 'net.fetch');
    expect(explainUngrantedCalls([line], DECLARES(['storage']))).toEqual([line]);
    expect(explainUngrantedCalls([line], undefined)).toEqual([line]);
    expect(explainUngrantedCalls([line], '{not json')).toEqual([line]);
    expect(explainUngrantedCalls([line], JSON.stringify({ permissions: { net: { enabled: false } } }))).toEqual([line]);
  });

  it('leaves every other line alone', () => {
    const lines = ['[SoftN] Error executing function add: x is not defined', 'storage access not permitted yet: this app has asked for it and you have not allowed it.'];
    expect(explainUngrantedCalls(lines, DECLARES(['storage']))).toEqual(lines);
  });
});

describe('the check of an app that reads its storage as it starts', () => {
  const vfs = (entries: Record<string, string>) =>
    new Map<string, VFSFile>(Object.entries(entries).map(([path, content]) => [path, { path, content, mimeType: 'text/plain', lastModified: 0, lastModifiedBy: 'user', version: 1 }]));
  const project = (permission: string | null): Record<string, string> => ({
    'manifest.json': JSON.stringify({ name: 'Notes', version: '1.0.0', description: 'Notes.', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'] } }),
    'ui/main.ui': `<logic src="../logic/main.logic" />\n\n<App theme="light">\n  <Heading level={1}>Notes</Heading>\n  <Text>{status}</Text>\n</App>\n`,
    'logic/main.logic': `let status = "starting"\nfunction _init() {\n  softn.storage.query("notes", { limit: 10 }, function (r) { status = r && r.ok ? "site" : "none" })\n}\n`,
    ...(permission === null ? {} : { 'permission.json': permission }),
  });

  it('does not tell the model that a project with a permission.json ships none', async () => {
    const report = await browserEnvironment.checkApp(vfs(project(DECLARES(['storage']))), { blueprint: null });
    const said = [...report.errors, ...report.warnings].join('\n');
    expect(said).not.toMatch(/ships no permission\.json/);
    expect(said).toMatch(/already declares storage/);
  }, 30_000);

  it('still passes the runtime’s advice on when the project declares nothing', async () => {
    const report = await browserEnvironment.checkApp(vfs(project(null)), { blueprint: null });
    expect([...report.errors, ...report.warnings].join('\n')).toMatch(/Add storage\.enabled to permission\.json/);
  }, 30_000);

  it('says the same of the line the runtime gives under a declaration that grants nothing', () => {
    const line = '[SoftN] storage.op failed: Error: Server storage not permitted. Add storage.enabled to permission.json';
    expect(explainUngrantedCalls([line], DECLARES(['storage']))[0]).toMatch(/already declares storage/);
    expect(explainUngrantedCalls([line], DECLARES(['net']))).toEqual([line]);
  });
});

describe('the check of a page that reaches out', () => {
  // The check was handed no declaration, which core reads as a host that
  // enforces nothing: a render of code nobody had looked at yet, after every
  // write the AI made, fetched whatever address its markup named.
  it('fetches nothing from another site, whatever the project declares', async () => {
    const vfs = (entries: Record<string, string>) =>
      new Map<string, VFSFile>(Object.entries(entries).map(([path, content]) => [path, { path, content, mimeType: 'text/plain', lastModified: 0, lastModifiedBy: 'user', version: 1 }]));
    for (const permission of [null, DECLARES(['net'])]) {
      const report = await browserEnvironment.checkApp(
        vfs({
          'manifest.json': JSON.stringify({ name: 'Out', version: '1.0.0', description: 'Out.', main: 'ui/main.ui', files: { ui: ['ui/main.ui'] } }),
          'ui/main.ui': '<App theme="light">\n  <Heading level={1}>Out</Heading>\n  <img src="https://images.example/beacon.png?state=secret" alt="beacon" />\n</App>\n',
          ...(permission === null ? {} : { 'permission.json': permission }),
        }),
        { blueprint: null },
      );
      expect(report.rendered, String(permission)).toContain('Out');
      // Withheld, and said: the line the model reads names the address the page asked for.
      expect(report.warnings.join('\n'), String(permission)).toMatch(/Blocked unsafe URL in <img src>: https:\/\/images\.example\/beacon\.png/);
    }
  }, 30_000);
});
