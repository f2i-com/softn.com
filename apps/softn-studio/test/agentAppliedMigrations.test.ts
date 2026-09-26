/**
 * In a hosted editor, the migrations the project was opened with have run on the app's database:
 * the agent's file tools refuse to change, delete or rename them, and say to add the next numbered
 * migration instead, which goes through. The bridge is a scripted host; the loop, the tools and
 * the VFS are real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostedAIReply, HostedAIRequest } from '@softn/editor-shared/hostedEditor';

const host = vi.hoisted(() => ({ replies: [] as Array<unknown>, requests: [] as Array<HostedAIRequest> }));

vi.mock('@softn/editor-shared/hostedEditor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@softn/editor-shared/hostedEditor')>();
  return {
    ...actual,
    isHostedEditor: () => true,
    hostedAIToolsVersion: () => 1,
    requestHostedAIReply: async (request: HostedAIRequest): Promise<HostedAIReply> => {
      host.requests.push(JSON.parse(JSON.stringify(request)) as HostedAIRequest);
      const reply = host.replies.shift();
      if (reply === undefined) throw new Error('The scripted host has no reply left.');
      return actual.readHostedAIReply(reply);
    },
  };
});

const { startAgentRun } = await import('../src/lib/agent/runAgent');
const { appliedMigrationRefusal, forgetAppliedMigrations, rememberAppliedMigrations } = await import('../src/lib/agent/appliedMigrations');
const { useVFSStore } = await import('../src/stores/vfsStore');
const { assertScriptsPassed, lastRun, resetAgent, say, seedApp, text } = await import('./helpers/agentHarness');

const FIRST = 'CREATE TABLE items(id INTEGER PRIMARY KEY, title TEXT NOT NULL);';
const FORMLOGIC = { id: 'formlogic', type: 'custom' as const, name: 'FormLogic AI', apiKey: '', modelId: 'host-default' };

beforeEach(() => {
  resetAgent(FORMLOGIC);
  seedApp();
  useVFSStore.getState().batchCreateFiles([{ path: 'server/migrations/001.sql', content: FIRST }], 'user');
  rememberAppliedMigrations(useVFSStore.getState().files);
  host.replies = [];
  host.requests = [];
});
afterEach(() => {
  forgetAppliedMigrations();
  assertScriptsPassed();
  expect(host.replies).toEqual([]);
});

const call = (id: string, name: string, args: Record<string, unknown>) => ({ text: '', toolCalls: [{ id, name, arguments: args }], stopReason: 'tool_use' });
const toolResult = (request: HostedAIRequest, id: string) => request.messages.find((m) => m.role === 'tool' && m.toolCallId === id) as { content: string; isError?: boolean } | undefined;

describe('migrations the host already ran', () => {
  it('are refused to a rewrite, with the next migration named; the next migration goes through', async () => {
    host.replies = [
      call('r1', 'read_file', { path: 'server/migrations/001.sql' }),
      call('w1', 'write_file', { path: 'server/migrations/001.sql', content: 'CREATE TABLE recipes(id INTEGER PRIMARY KEY, title TEXT);' }),
      call('w2', 'write_file', { path: 'server/migrations/002.sql', content: 'ALTER TABLE items ADD COLUMN favourite INTEGER NOT NULL DEFAULT 0;' }),
      call('f1', 'finish', { summary: 'Added a favourite column.' }),
    ];
    say('Add favourites');
    await startAgentRun();
    expect(lastRun().run.status).toBe('finished');

    const refused = toolResult(host.requests[2], 'w1');
    expect(refused?.isError).toBe(true);
    expect(refused?.content).toContain('server/migrations/001.sql has already run on this app\'s database');
    expect(refused?.content).toContain('server/migrations/002.sql');
    expect(text('server/migrations/001.sql')).toBe(FIRST);
    expect(text('server/migrations/002.sql')).toContain('ALTER TABLE items ADD COLUMN favourite');
  });

  it('refuse an edit, a delete and a rename; writing one back unchanged is not a change', () => {
    expect(appliedMigrationRefusal('server/migrations/001.sql', 'edit')).toContain('cannot change');
    expect(appliedMigrationRefusal('server/migrations/001.sql', 'delete')).toContain('cannot be deleted');
    expect(appliedMigrationRefusal('server/migrations/001.sql', 'rename')).toContain('cannot be renamed');
    expect(appliedMigrationRefusal('server/migrations/001.sql', 'replace', FIRST)).toBeNull();
    expect(appliedMigrationRefusal('server/migrations/002.sql', 'edit')).toBeNull();
    expect(appliedMigrationRefusal('ui/main.ui', 'delete')).toBeNull();
    // Outside a hosted editor nothing is remembered, and a migration may be rewritten.
    forgetAppliedMigrations();
    expect(appliedMigrationRefusal('server/migrations/001.sql', 'edit')).toBeNull();
  });
});
