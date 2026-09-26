/** @vitest-environment jsdom */
/**
 * check_app and a private backend: the entry loads and defines a function for every route, the
 * routes are ones a host serves, and the migrations it lists exist — checked before a host
 * refuses the whole version. The engine is the real ZIPP one.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerAllBuiltins } from '@softn/components';
import { configureZippWasmSource } from '@softn/core';
import { browserEnvironment } from '../src/lib/agent/appCheck';
import { forgetAppliedMigrations, rememberAppliedMigrations } from '../src/lib/agent/appliedMigrations';
import type { VFSFile } from '../src/types/studio';
import { APP } from './helpers/agentHarness';

beforeAll(() => {
  configureZippWasmSource(readFileSync(resolve(process.cwd(), '../../packages/@softn/core/wasm-zipp/zipp_wasm_bg.wasm')));
  registerAllBuiltins();
});

const vfs = (entries: Record<string, string>) =>
  new Map<string, VFSFile>(Object.entries(entries).map(([path, content]) => [path, { path, content, mimeType: 'text/plain', lastModified: 0, lastModifiedBy: 'user', version: 1 }]));

const ROUTES = [
  { path: '/api/items', method: 'GET', handler: 'listItems', transaction: 'read', authorization: 'anonymous' },
  { path: '/api/items', method: 'POST', handler: 'createItem', transaction: 'write', authorization: 'anonymous' },
];
const BACKEND = `function listItems(req) {
  return {status: 200, body: {items: softn.sql.query("SELECT id, title FROM items", [])}};
}
function createItem(req) {
  softn.sql.execute("INSERT INTO items(title) VALUES(?)", [req.body.title]);
  return {status: 201, body: {}};
}`;

function project({ routes = ROUTES, backend = BACKEND, migrations = ['server/migrations/001.sql'], extra = {} as Record<string, string> } = {}) {
  const manifest = { ...JSON.parse(APP.manifest), server: { entry: 'server/main.logic', requires: { apiVersion: 1, capabilities: ['sql'] }, database: { kind: 'private-sqlite', migrations }, routes } };
  return vfs({
    'manifest.json': JSON.stringify(manifest),
    'ui/main.ui': APP.ui,
    'logic/main.logic': APP.logic,
    'server/main.logic': backend,
    'server/migrations/001.sql': 'CREATE TABLE items(id INTEGER PRIMARY KEY, title TEXT NOT NULL);',
    ...extra,
  });
}
const backendLines = (lines: string[]) => lines.filter((line) => /server\/|route |migrations/.test(line));

describe('check_app with a private backend', () => {
  it('passes a backend that loads and defines every route', async () => {
    const report = await browserEnvironment.checkApp(project(), { blueprint: null });
    expect(backendLines(report.errors)).toEqual([]);
    expect(backendLines(report.warnings)).toEqual([]);
  });

  it('reports a backend that does not load, as its host would refuse it', async () => {
    const report = await browserEnvironment.checkApp(project({ backend: 'function listItems(req) {\n  return {status: 200, body: {}\n}' }), { blueprint: null });
    expect(report.ok).toBe(false);
    expect(report.errors.some((line) => line.startsWith('server/main.logic does not load, so its host would refuse the whole version'))).toBe(true);
  });

  it('reports a route whose handler the backend does not define', async () => {
    const report = await browserEnvironment.checkApp(project({ backend: BACKEND.replace('function createItem', 'function addItem') }), { blueprint: null });
    expect(report.errors).toContain('server/main.logic: route POST /api/items names createItem, which server/main.logic does not define as a top-level function.');
  });

  it('reports routes a host does not serve, and a migration that is not there or not listed', async () => {
    const report = await browserEnvironment.checkApp(project({
      routes: [...ROUTES, { path: '/api/items/:id', method: 'PATCH', handler: 'listItems', transaction: 'write', authorization: 'anonymous' }, ROUTES[0]],
      migrations: ['server/migrations/001.sql', 'server/migrations/002.sql'],
      extra: { 'server/migrations/003.sql': 'CREATE TABLE later(id INTEGER PRIMARY KEY);' },
    }), { blueprint: null });
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('route PATCH /api/items/:id needs a path under /api/'),
      'manifest.json: route PATCH /api/items/:id needs a method of GET, POST, PUT or DELETE.',
      'manifest.json: route GET /api/items is declared twice.',
      'manifest.json: server.database.migrations lists server/migrations/002.sql, which is not a text file in the project.',
    ]));
    expect(report.warnings).toContain("server/migrations/003.sql is not listed in manifest.json's server.database.migrations, so the host never runs it.");
  });

  it('reports a route setting and a migration list a host refuses to start with', async () => {
    const report = await browserEnvironment.checkApp(project({
      routes: [{ ...ROUTES[0], authorization: 'public' }, { ...ROUTES[1], transaction: 'serializable' }],
      migrations: ['server/migrations/001.sql', './server/migrations/001.sql'],
    }), { blueprint: null });
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('route GET /api/items has "authorization": "public"'),
      expect.stringContaining('route POST /api/items has "transaction": "serializable"'),
      "manifest.json: server.database.migrations lists server/migrations/001.sql twice; a host refuses a migration listed twice.",
    ]));
  });

  it('reads an entry written as ./server/main.logic as the host does', async () => {
    const files = project();
    const manifest = JSON.parse(files.get('manifest.json')!.content as string);
    manifest.server.entry = './server/main.logic';
    files.set('manifest.json', { ...files.get('manifest.json')!, content: JSON.stringify(manifest) });
    const report = await browserEnvironment.checkApp(files, { blueprint: null });
    expect(backendLines(report.errors)).toEqual([]);
  });

  it('reports a migration the host ran that the manifest no longer lists', async () => {
    rememberAppliedMigrations(project());
    try {
      const report = await browserEnvironment.checkApp(project({ migrations: [] }), { blueprint: null });
      expect(report.errors).toContain("server/migrations/001.sql has already run on this app's database, so manifest.json's server.database.migrations must keep listing it; the host refuses to start without it.");
      expect(report.warnings.some((line) => line.startsWith('server/migrations/001.sql is not listed'))).toBe(false);
    } finally {
      forgetAppliedMigrations();
    }
  });

  it('checks nothing for an app with no backend', async () => {
    const report = await browserEnvironment.checkApp(vfs({ 'manifest.json': APP.manifest, 'ui/main.ui': APP.ui, 'logic/main.logic': APP.logic }), { blueprint: null });
    expect(backendLines(report.errors)).toEqual([]);
  });
});
