/**
 * Round 4 review of compaction's rule that a file stops counting as read whole once the
 * conversation no longer holds its text (Round 3, compaction.ts): a file renamed after it was
 * read is that same text under its new name, and the rename carried the whole read across.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startAgentRun } from '../src/lib/agent/runAgent';
import { useVFSStore } from '../src/stores/vfsStore';
import { assertScriptsPassed, fakeProvider, lastRun, resetAgent, say, seedApp } from './helpers/agentHarness';

beforeEach(() => resetAgent());
afterEach(() => {
  assertScriptsPassed();
  resetAgent();
});

const big = (v: string) => `<logic src="../logic/main.logic" />\n\n<App>\n${Array.from({ length: 40 }, (_, i) => `  <Text>{count} ${v} line ${i}</Text>`).join('\n')}\n</App>`;
const list = { calls: [{ name: 'list_files', input: {} }] };

describe('a file renamed after it was read, once the read is compacted away', () => {
  it('is no longer counted as read whole under its new name', async () => {
    seedApp();
    useVFSStore.getState().createFile('ui/week.ui', big('first'));
    fakeProvider('anthropic', [
      { calls: [{ name: 'read_file', input: { path: 'ui/week.ui' } }] },
      { calls: [{ name: 'rename_file', input: { from: 'ui/week.ui', to: 'ui/days.ui' } }] },
      ...Array.from({ length: 7 }, () => list),
      (body: Record<string, unknown>) => {
        // The read's text is gone from the conversation...
        expect(JSON.stringify(body.messages)).toMatch(/\[read_file result from step 1, \d+ lines; ui\/week\.ui has been changed since\./);
        // ...so a write of the whole file can only be from memory.
        return { calls: [{ name: 'write_file', input: { path: 'ui/days.ui', content: '<App>\n  <Text>From memory</Text>\n</App>' } }] };
      },
      { calls: [{ name: 'finish', input: { summary: 'ok' } }] },
    ]);
    say('Rename the week');
    await startAgentRun();
    const write = lastRun().run.entries.find((e) => e.kind === 'tool' && e.name === 'write_file');
    expect(write && write.kind === 'tool' ? write.status : null).toBe('error');
    expect(useVFSStore.getState().readFile('ui/days.ui')).toContain('first line 39');
  });

  it('is still whole when it was read again whole after the rename', async () => {
    seedApp();
    useVFSStore.getState().createFile('ui/week.ui', big('first'));
    fakeProvider('anthropic', [
      { calls: [{ name: 'read_file', input: { path: 'ui/week.ui' } }] },
      { calls: [{ name: 'rename_file', input: { from: 'ui/week.ui', to: 'ui/days.ui' } }] },
      { calls: [{ name: 'read_file', input: { path: 'ui/days.ui' } }] },
      ...Array.from({ length: 6 }, () => list),
      { calls: [{ name: 'write_file', input: { path: 'ui/days.ui', content: '<App>\n  <Text>Rewritten</Text>\n</App>' } }] },
      { calls: [{ name: 'finish', input: { summary: 'ok' } }] },
    ]);
    say('Rename the week');
    await startAgentRun();
    const write = lastRun().run.entries.find((e) => e.kind === 'tool' && e.name === 'write_file');
    expect(write && write.kind === 'tool' ? write.status : null).toBe('ok');
    expect(useVFSStore.getState().readFile('ui/days.ui')).toContain('Rewritten');
  });
});
