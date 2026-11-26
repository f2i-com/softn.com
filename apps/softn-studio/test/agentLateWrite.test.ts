/**
 * A tool call that is still working when its run is stopped, or when another project takes
 * this one's place.
 *
 * Most tools write at once, but the SQLite tools wait first (the engine loads, the first time
 * on a page, and the database opens), and then write records made from the files the call
 * began with. Stop had already told the model the call did not run, and the write landed all
 * the same; and when another project had been opened meanwhile, the old project's manifest
 * was written over the new project's. Nothing is written now by a call that is no longer its
 * run's, nor over a file that changed while it waited.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqliteToolDeps } from '../src/lib/agent/sqliteTools';

let release: () => void = () => {};
let gate: Promise<void> = Promise.resolve();
let started = 0;

vi.mock('../src/lib/agent/sqliteTools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/agent/sqliteTools')>();
  return {
    ...actual,
    // As the real one does: wait for the engine, then write the database and its entry in the
    // manifest, made from the files the call began with.
    runSqliteExecute: async (_input: Record<string, unknown>, deps: SqliteToolDeps) => {
      started++;
      await gate;
      const manifest = JSON.parse(String(deps.files.get('manifest.json')?.content ?? '{}')) as Record<string, unknown>;
      try {
        const transactionId = deps.commit([
          { op: 'create', path: 'app.db', content: new Uint8Array([1, 2, 3]) },
          { op: 'update', path: 'manifest.json', content: JSON.stringify({ ...manifest, databases: [{ name: 'app', engine: 'sqlite', file: 'app.db' }] }) },
        ], []);
        return { isError: false, subject: 'app.db', changed: true, transactionId, content: 'Created app.db.' };
      } catch (err) {
        return { isError: true, subject: 'app.db', content: `SQLite execution failed on app.db: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
});

const { startAgentRun, stopAgentRun } = await import('../src/lib/agent/runAgent');
const { beginReplacingProject } = await import('../src/lib/replaceProject');
const { executeTool } = await import('../src/lib/agent/executeTool');
const { useVFSStore } = await import('../src/stores/vfsStore');
const { APP, assertScriptsPassed, fakeProvider, lastRun, nodeEnvironment, resetAgent, say, seedApp, text } = await import('./helpers/agentHarness');

function holdTheEngine(): void {
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
}

beforeEach(() => {
  resetAgent();
  seedApp();
  started = 0;
  holdTheEngine();
});
afterEach(() => {
  release();
  assertScriptsPassed();
  resetAgent();
});

const OTHER_MANIFEST = JSON.stringify({ name: 'Another app', version: '2.0.0', main: 'index.html' }, null, 2);

describe('a call still working when its run ends', () => {
  it('writes nothing once Stop has told the model it did not run', async () => {
    fakeProvider('anthropic', [{ calls: [{ name: 'sqlite_execute', input: { sql: 'CREATE TABLE notes (id INTEGER)' } }] }]);
    say('Keep notes in a database');
    const running = startAgentRun();
    await vi.waitFor(() => expect(started).toBe(1));
    stopAgentRun();
    release();
    await running;
    expect(lastRun().run.status).toBe('stopped');
    expect(useVFSStore.getState().files.has('app.db')).toBe(false);
    expect(text('manifest.json')).toBe(APP.manifest);
    expect(lastRun().run.transactions).toEqual([]);
  });

  it('writes nothing into the project opened in its place', async () => {
    fakeProvider('anthropic', [{ calls: [{ name: 'sqlite_execute', input: { sql: 'CREATE TABLE notes (id INTEGER)' } }] }]);
    say('Keep notes in a database');
    const running = startAgentRun();
    await vi.waitFor(() => expect(started).toBe(1));
    // Another project is opened: what replaces a project discards its runs first.
    expect(beginReplacingProject()).not.toBeNull();
    useVFSStore.getState().reset();
    useVFSStore.getState().hydrateFiles([{ path: 'manifest.json', content: OTHER_MANIFEST }, { path: 'index.html', content: '<h1>Another</h1>' }]);
    release();
    await running;
    expect(text('manifest.json')).toBe(OTHER_MANIFEST);
    expect(useVFSStore.getState().files.has('app.db')).toBe(false);
    expect(useVFSStore.getState().history).toEqual([]);
  });

  it('writes nothing over a file that changed while it waited, and says so', async () => {
    const outcome = executeTool(
      { id: 'c1', name: 'sqlite_execute', input: { sql: 'CREATE TABLE notes (id INTEGER)' } },
      { seen: new Map(), env: nodeEnvironment, blueprint: null, newTransactionId: () => 't1' },
    );
    await vi.waitFor(() => expect(started).toBe(1));
    // Another tab's save of the manifest, taken in meanwhile (lib/projectSession.ts).
    useVFSStore.getState().takeInFiles([{ path: 'manifest.json', content: APP.manifest.replace('"Tasks"', '"Chores"') }]);
    release();
    const result = await outcome;
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/manifest\.json changed while this ran/);
    expect(text('manifest.json')).toContain('"Chores"');
    expect(useVFSStore.getState().files.has('app.db')).toBe(false);
  });
});
