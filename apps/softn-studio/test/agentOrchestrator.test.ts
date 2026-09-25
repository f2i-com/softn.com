/**
 * The chat's entry points (runAgentTurn / abortAgentTurn) and the guarantees
 * the single-shot turn made, re-pinned against the agent loop that replaced
 * it. The intent of each is unchanged:
 *
 *   - a turn never falls back to another provider or a guessed model;
 *   - a reply that arrives after its turn was abandoned writes nothing;
 *   - what the model was shown is what it may replace — a file read in part
 *     cannot be replaced whole, and a file changed under the request (edited,
 *     or deleted and re-created) is not overwritten from old content;
 *   - every write is a transaction that can be reverted by its id;
 *   - a budget is checked before a request is sent, and timeouts and rate
 *     limits are distinct, recoverable failures.
 *
 * The unit tests of the single-shot helpers that remain (the file-block
 * parser, the budgeted file view, checkWrite) are kept as they were.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { abortAgentTurn, buildFileContents, checkWrite, parseAIResponse, runAgentTurn } from '../src/lib/agentOrchestrator';
import { continueAgentRun } from '../src/lib/agent/runAgent';
import { useAIStore } from '../src/stores/aiStore';
import { useVFSStore } from '../src/stores/vfsStore';
import { useWorkspaceStore } from '../src/stores/workspaceStore';
import type { VFSFile } from '../src/types/studio';
import { assertScriptsPassed, fakeProvider, lastRun, resetAgent, resultsIn, say } from './helpers/agentHarness';

const lastMessage = () => useAIStore.getState().messages.at(-1)!;

beforeEach(() => {
  resetAgent({ id: 'test', type: 'custom', name: 'Test provider', apiKey: '', baseUrl: 'https://example.invalid', modelId: 'test-model' });
  say('Build it');
});
afterEach(() => {
  assertScriptsPassed();
  resetAgent();
});

describe('agent turn ownership', () => {
  it('never falls back to a different provider after the selected one is removed', async () => {
    const provider = fakeProvider('openai', []);
    useAIStore.setState({ activeProviderId: null });
    await runAgentTurn();
    expect(provider.count()).toBe(0);
    expect(lastMessage().content).toMatch(/Select an AI provider/);
    expect(useAIStore.getState().iterationsUsed).toBe(0);
  });

  it('asks for a model instead of sending when the provider has none (an old default-model provider)', async () => {
    const provider = fakeProvider('anthropic', []);
    useAIStore.setState({ providers: [{ id: 'old', type: 'anthropic', name: 'Anthropic', apiKey: 'k' }], activeProviderId: 'old' });
    await runAgentTurn();
    expect(provider.count()).toBe(0);
    expect(lastMessage().content).toMatch(/Anthropic has no model chosen yet.*AI setup/);
    expect(useAIStore.getState().lastFailure?.kind).toBe('setup');
    expect(useAIStore.getState().iterationsUsed).toBe(0);
    expect(useAIStore.getState().agentState).toBe('idle');
  });

  it('uses a generation model chosen in Settings when the provider has none of its own', async () => {
    useAIStore.setState({ providers: [{ id: 'old', type: 'anthropic', name: 'Anthropic', apiKey: 'k' }], activeProviderId: 'old', modelProfile: { architect: '', builder: 'picked', repair: '', vision: '' } });
    const provider = fakeProvider('anthropic', [{ calls: [{ name: 'finish', input: { summary: 'done' } }] }]);
    await runAgentTurn();
    expect(provider.bodies[0].model).toBe('picked');
  });

  it('does not carry one provider’s generation model to another', async () => {
    useAIStore.setState({
      providers: [
        { id: 'a', type: 'anthropic', name: 'Anthropic', apiKey: 'k', modelId: 'a-model' },
        { id: 'old', type: 'openai', name: 'OpenAI', apiKey: 'k' },
      ],
      activeProviderId: 'a',
      modelProfile: { architect: '', builder: 'a-other-model', repair: '', vision: '' },
    });
    useAIStore.getState().setActiveProvider('old');
    expect(useAIStore.getState().modelProfile.builder).toBe('');
    const provider = fakeProvider('openai', []);
    await runAgentTurn();
    expect(provider.count()).toBe(0);
    expect(lastMessage().content).toMatch(/OpenAI has no model chosen yet/);
  });

  it('reports a provider failure mentioning abort when the user did not cancel', async () => {
    fakeProvider('openai', [{ error: { status: 500, body: { error: { message: 'Upstream transaction aborted' } } } }]);
    await runAgentTurn();
    const { run } = lastRun();
    expect(run.status).toBe('failed');
    expect(run.reason).toContain('Upstream transaction aborted');
    expect(useAIStore.getState().lastFailure?.kind).toBe('provider');
  });

  it('does not let an abandoned turn’s late reply write into the project or clear its replacement', async () => {
    const provider = fakeProvider('openai', [
      { calls: [{ name: 'write_file', input: { path: 'stale.txt', content: 'old project' } }] },
      { calls: [{ name: 'write_file', input: { path: 'also-stale.txt', content: 'cancelled' } }] },
    ]);
    const firstGate = provider.hold();
    const first = runAgentTurn();
    await new Promise((r) => setTimeout(r, 0));
    // The project changes under the chat.
    abortAgentTurn();
    expect(useAIStore.getState().agentState).toBe('idle');

    say('Build the other one');
    const secondGate = provider.hold();
    const second = runAgentTurn();
    await new Promise((r) => setTimeout(r, 0));
    expect(useAIStore.getState().agentState).toBe('building');

    firstGate.release();
    await first;
    expect(useVFSStore.getState().files.has('stale.txt')).toBe(false);
    expect(useAIStore.getState().agentState).toBe('building');

    abortAgentTurn();
    secondGate.release();
    await second;
    expect(useVFSStore.getState().files.has('also-stale.txt')).toBe(false);
    expect(useAIStore.getState().agentState).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// What the model was shown is what it may replace.
//
// The single-shot prompt showed at most 6,000 characters of a file and asked
// for whole-file replacements, so a model editing the head of a long file
// returned the head and the tail was gone. The agent reads what it needs, and
// the run records how much of each file it read and at which version.
// ---------------------------------------------------------------------------

const HEAD = '// head of the file\nfunction start() { return 1 }\n';
const FILLER = '// filler line to push the tail far down the file\n'.repeat(240);
const TAIL = '\n// SENTINEL-TAIL-7f3a\nfunction needed() { return "still here" }\n';
const LONG = HEAD + FILLER + TAIL;

describe('what the model has read is what it may replace', () => {
  beforeEach(() => {
    useVFSStore.getState().hydrateFiles([
      { path: 'logic/app.logic', content: LONG },
      { path: 'ui/main.ui', content: '<App/>' },
    ]);
  });

  it('refuses a whole-file replacement of a file read only in part, so the tail survives', async () => {
    fakeProvider('openai', [
      { calls: [{ name: 'read_file', input: { path: 'logic/app.logic', start_line: 1, end_line: 10 } }, { name: 'write_file', input: { path: 'logic/app.logic', content: HEAD.replace('start', 'begin') } }] },
      { calls: [{ name: 'finish', input: { summary: 'x' } }] },
    ]);
    await runAgentTurn();
    expect(useVFSStore.getState().readFile('logic/app.logic')).toBe(LONG);
    const write = lastRun().run.entries.find((e) => e.kind === 'tool' && e.name === 'write_file');
    expect(write?.kind === 'tool' && write.status).toBe('error');
    expect(write?.kind === 'tool' && write.result).toMatch(/read only part of logic\/app\.logic/);
  });

  it('pages a read of a file longer than one read: it can then be edited, but not replaced whole', async () => {
    const longer = LONG + '// more\n'.repeat(300);
    useVFSStore.getState().hydrateFiles([{ path: 'logic/app.logic', content: longer }]);
    fakeProvider('openai', [
      { calls: [{ name: 'read_file', input: { path: 'logic/app.logic' } }] },
      (body) => {
        // The read stopped at 400 lines and said how to read on.
        expect(resultsIn(body)).toContain('read on with start_line 401');
        return { calls: [{ name: 'write_file', input: { path: 'logic/app.logic', content: HEAD } }, { name: 'edit_file', input: { path: 'logic/app.logic', old_string: 'function start()', new_string: 'function begin()' } }] };
      },
      { calls: [{ name: 'finish', input: { summary: 'Done.' } }] },
    ]);
    await runAgentTurn();
    const content = useVFSStore.getState().readFile('logic/app.logic') as string;
    expect(content).toBe(longer.replace('function start()', 'function begin()'));
  });

  it('accepts the replacement of a file read whole, naming the change in the timeline', async () => {
    fakeProvider('openai', [
      { calls: [{ name: 'read_file', input: { path: 'logic/app.logic' } }, { name: 'write_file', input: { path: 'logic/app.logic', content: LONG.replace('start', 'begin') } }] },
      { calls: [{ name: 'finish', input: { summary: 'Done.' } }] },
    ]);
    await runAgentTurn();
    const content = useVFSStore.getState().readFile('logic/app.logic') as string;
    expect(content).toContain('function begin()');
    expect(content).toContain('SENTINEL-TAIL-7f3a');
    expect(lastMessage().content).toBe('Done.');
  });

  it('refuses to overwrite a file edited while the request was in flight', async () => {
    fakeProvider('openai', [
      { calls: [{ name: 'read_file', input: { path: 'ui/main.ui' } }] },
      () => {
        // The person edits the file while the model is thinking.
        useVFSStore.getState().updateFile('ui/main.ui', '<App theme="dark"/>', 'user');
        return { calls: [{ name: 'write_file', input: { path: 'ui/main.ui', content: '<App title="from old content"/>' } }] };
      },
      { calls: [{ name: 'finish', input: { summary: 'x' } }] },
    ]);
    await runAgentTurn();
    expect(useVFSStore.getState().readFile('ui/main.ui')).toBe('<App theme="dark"/>');
    const write = lastRun().run.entries.find((e) => e.kind === 'tool' && e.name === 'write_file');
    expect(write?.kind === 'tool' && write.result).toMatch(/changed since you read it/);
  });

  it('refuses edits and deletes built on a file that was deleted and re-created since it was read', async () => {
    fakeProvider('openai', [
      { calls: [{ name: 'read_file', input: { path: 'ui/main.ui' } }] },
      () => {
        // STU-06: a re-created file used to restart at version 1, the version the reply was built on.
        useVFSStore.getState().deleteFile('ui/main.ui', 'user');
        useVFSStore.getState().createFile('ui/main.ui', '<App theme="recreated"/>', 'user');
        return { calls: [{ name: 'edit_file', input: { path: 'ui/main.ui', old_string: '<App', new_string: '<App title="x"' } }, { name: 'delete_file', input: { path: 'ui/main.ui' } }] };
      },
      { calls: [{ name: 'finish', input: { summary: 'x' } }] },
    ]);
    await runAgentTurn();
    expect(useVFSStore.getState().readFile('ui/main.ui')).toBe('<App theme="recreated"/>');
    const results = lastRun().run.entries.filter((e) => e.kind === 'tool' && (e.name === 'edit_file' || e.name === 'delete_file'));
    expect(results.every((e) => e.kind === 'tool' && e.status === 'error' && /changed since you read it/.test(e.result))).toBe(true);
  });
});

describe('each write as a transaction', () => {
  beforeEach(() => {
    useVFSStore.getState().hydrateFiles([
      { path: 'ui/main.ui', content: '<App>\n  <Text>one</Text>\n</App>' },
      { path: 'ui/about.ui', content: '<About/>' },
      { path: 'assets/logo.png', content: new Uint8Array([1, 2, 3]) },
    ]);
  });

  it('commits each write under its own id, reverts one by its id, and marks the project dirty', async () => {
    fakeProvider('openai', [
      { calls: [{ name: 'write_file', input: { path: 'ui/new.ui', content: '<New/>' } }, { name: 'delete_file', input: { path: 'assets/logo.png' } }] },
      { calls: [{ name: 'finish', input: { summary: 'x' } }] },
    ]);
    await runAgentTurn();
    const { run } = lastRun();
    expect(run.transactions).toHaveLength(2);
    expect(useVFSStore.getState().history.map((e) => e.transactionId)).toEqual(run.transactions);
    expect(useWorkspaceStore.getState().isDirty).toBe(true);
    expect(useVFSStore.getState().revertTransaction(run.transactions[1]).ok).toBe(true);
    expect(useVFSStore.getState().readFile('assets/logo.png')).toEqual(new Uint8Array([1, 2, 3]));
    expect(useVFSStore.getState().files.has('ui/new.ui')).toBe(true);
  });

  it('refuses to write private editor state however it is spelled', async () => {
    fakeProvider('openai', [
      { calls: [{ name: 'write_file', input: { path: 'Builder\\blueprint.json', content: '{}' } }] },
      { calls: [{ name: 'finish', input: { summary: 'x' } }] },
    ]);
    await runAgentTurn();
    expect(useVFSStore.getState().files.size).toBe(3);
    const write = lastRun().run.entries.find((e) => e.kind === 'tool' && e.name === 'write_file');
    expect(write?.kind === 'tool' && write.result).toMatch(/private/i);
  });

  it('refuses to send a request the remaining budget cannot cover', async () => {
    useAIStore.setState({ tokenBudget: 1000, tokensUsed: 0 });
    const provider = fakeProvider('openai', []);
    await runAgentTurn();
    expect(provider.count()).toBe(0);
    expect(lastRun().run.reason).toMatch(/budget/i);
    expect(useAIStore.getState().lastFailure?.kind).toBe('budget');
    expect(useAIStore.getState().agentState).toBe('idle');
  });

  it('keeps what an earlier step wrote when a later request fails, and says how to go on', async () => {
    fakeProvider('openai', [
      { calls: [{ name: 'write_file', input: { path: 'ui/new.ui', content: '<New/>' } }] },
      { error: { status: 429, body: { error: { message: 'Rate limited.' } }, headers: { 'retry-after': '7' } } },
      { error: { status: 429, body: { error: { message: 'Rate limited.' } }, headers: { 'retry-after': '7' } } },
      { error: { status: 429, body: { error: { message: 'Rate limited.' } }, headers: { 'retry-after': '7' } } },
      { error: { status: 429, body: { error: { message: 'Rate limited.' } }, headers: { 'retry-after': '7' } } },
      { calls: [{ name: 'finish', input: { summary: 'Back.' } }] },
    ]);
    await runAgentTurn();
    let { run } = lastRun();
    expect(run.status).toBe('paused');
    expect(useAIStore.getState().lastFailure).toMatchObject({ kind: 'rate-limited', retryAfterMs: 7000 });
    expect(run.reason).toMatch(/7 s/);
    expect(useVFSStore.getState().files.has('ui/new.ui')).toBe(true);
    expect(run.transactions).toHaveLength(1);
    await continueAgentRun(run.id);
    ({ run } = lastRun());
    expect(run.status).toBe('finished');
  });
});

// ---------------------------------------------------------------------------
// The single-shot helpers that remain
// ---------------------------------------------------------------------------

describe('the budgeted file view', () => {
  it('marks a long file truncated and a short one complete, with the version each was shown at', () => {
    const files = new Map<string, VFSFile>([
      ['logic/app.logic', { path: 'logic/app.logic', content: LONG, mimeType: 'text/x-softn-logic', lastModified: 1, lastModifiedBy: 'user', version: 3 }],
      ['ui/main.ui', { path: 'ui/main.ui', content: '<App/>', mimeType: 'text/x-softn-ui', lastModified: 1, lastModifiedBy: 'user', version: 1 }],
    ]);
    expect(LONG.length).toBeGreaterThan(12000);
    const { text, supplied } = buildFileContents(files);
    expect(supplied.get('logic/app.logic')).toMatchObject({ complete: false, version: 3, shown: 6000, total: LONG.length });
    expect(supplied.get('ui/main.ui')).toMatchObject({ complete: true, version: 1 });
    expect(text).toContain('TRUNCATED: first 6000 of');
    expect(text).not.toContain('SENTINEL-TAIL-7f3a');
    const whole = buildFileContents(files, 6000, 80000, new Set(['logic/app.logic']));
    expect(whole.supplied.get('logic/app.logic')?.complete).toBe(true);
    expect(whole.text).toContain('SENTINEL-TAIL-7f3a');
  });

  it('names each binary file as present but not shown, and never private state', () => {
    const files = new Map<string, VFSFile>([
      ['ui/main.ui', { path: 'ui/main.ui', content: '<App/>', mimeType: 'text/plain', lastModified: 1, lastModifiedBy: 'user', version: 1 }],
      ['assets/logo.png', { path: 'assets/logo.png', content: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png', lastModified: 1, lastModifiedBy: 'user', version: 1 }],
      ['builder/thumb.png', { path: 'builder/thumb.png', content: new Uint8Array([1]), mimeType: 'image/png', lastModified: 1, lastModifiedBy: 'user', version: 1 }],
    ]);
    const { text, supplied } = buildFileContents(files);
    expect(text).toContain('assets/logo.png (4 bytes)');
    expect(text).not.toContain('builder/thumb.png');
    expect([...supplied.keys()]).toEqual(['ui/main.ui']);
  });

  it('parses the old file-block format and strips it from the text', () => {
    const parsed = parseAIResponse('I need to see it first.\n<softn-read path="logic/app.logic" />\n<softn-read path="logic/app.logic" />');
    expect(parsed.reads).toEqual([{ path: 'logic/app.logic' }]);
    expect(parsed.text).toBe('I need to see it first.');
  });
});

describe('checkWrite', () => {
  const file = (version: number): VFSFile => ({ path: 'a', content: 'c', mimeType: 't', lastModified: 1, lastModifiedBy: 'user', version });
  const supplied = new Map([
    ['a', { path: 'a', complete: false, version: 1, shown: 6000, total: 9000 }],
    ['b', { path: 'b', complete: true, version: 2, shown: 10, total: 10 }],
  ]);

  it('allows a new file, refuses partial, unseen and stale for a whole replacement', () => {
    expect(checkWrite('new', supplied, undefined)).toBeNull();
    expect(checkWrite('a', supplied, file(1))).toEqual({ kind: 'partial', shown: 6000, total: 9000 });
    expect(checkWrite('c', supplied, file(1))).toEqual({ kind: 'unseen' });
    expect(checkWrite('b', supplied, file(3))).toEqual({ kind: 'stale', suppliedVersion: 2, currentVersion: 3 });
    expect(checkWrite('b', supplied, file(2))).toBeNull();
  });

  it('lets an exact edit go ahead on a file read in part, but not on one unread or changed', () => {
    expect(checkWrite('a', supplied, file(1), 'edit')).toBeNull();
    expect(checkWrite('c', supplied, file(1), 'edit')).toEqual({ kind: 'unseen' });
    expect(checkWrite('a', supplied, file(2), 'edit')).toEqual({ kind: 'stale', suppliedVersion: 1, currentVersion: 2 });
  });
});
