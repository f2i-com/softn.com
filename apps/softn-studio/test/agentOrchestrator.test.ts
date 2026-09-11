import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/aiProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/aiProvider')>()),
  sendAIRequest: vi.fn(),
}));

import { AIProviderError, sendAIRequest } from '../src/lib/aiProvider';
import { abortAgentTurn, buildFileContents, checkWrite, parseAIResponse, runAgentTurn } from '../src/lib/agentOrchestrator';
import { useAIStore } from '../src/stores/aiStore';
import { useVFSStore } from '../src/stores/vfsStore';
import { useWorkspaceStore } from '../src/stores/workspaceStore';
import type { VFSFile } from '../src/types/studio';

type Response = Awaited<ReturnType<typeof sendAIRequest>>;

/** A finished reply, as the provider adapter reports one. */
function reply(content: string, status: Response['status'] = 'complete'): Response {
  return {
    content,
    status,
    stopReason: status === 'truncated' ? 'max_tokens' : 'end_turn',
    blocks: [{ type: 'text', text: content }],
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.mocked(sendAIRequest).mockReset();
  abortAgentTurn();
  useAIStore.setState({
    providers: [
      {
        id: 'test',
        type: 'custom',
        name: 'Test provider',
        apiKey: '',
        baseUrl: 'https://example.invalid',
      },
    ],
    activeProviderId: 'test',
    messages: [
      {
        id: 'user-1',
        role: 'user',
        content: 'Build it',
        timestamp: 1,
      },
    ],
    agentState: 'idle',
    currentStep: '',
    iterationsUsed: 0,
    tokensUsed: 0,
    tokenBudget: 50000,
    filesChanged: 0,
    lastFailure: null,
  });
  useVFSStore.getState().reset();
  useWorkspaceStore.getState().reset();
});

describe('agent turn ownership', () => {
  it('does not let an aborted response write into or clear a replacement turn', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    vi.mocked(sendAIRequest).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const firstRun = runAgentTurn();
    const firstSignal = vi.mocked(sendAIRequest).mock.calls[0][1].signal!;

    abortAgentTurn();
    expect(firstSignal.aborted).toBe(true);

    const secondRun = runAgentTurn();
    const secondSignal = vi.mocked(sendAIRequest).mock.calls[1][1].signal!;
    expect(secondSignal.aborted).toBe(false);
    expect(useAIStore.getState().agentState).toBe('building');

    // Simulate a provider that ignores the aborted signal and resolves late.
    first.resolve(reply('<softn-file path="stale.txt">old project</softn-file>'));
    await firstRun;

    expect(useVFSStore.getState().files.has('stale.txt')).toBe(false);
    expect(useAIStore.getState().agentState).toBe('building');
    expect(secondSignal.aborted).toBe(false);

    // The replacement remains independently cancellable after the first
    // turn's finally block has run.
    abortAgentTurn();
    expect(secondSignal.aborted).toBe(true);

    second.resolve(reply('<softn-file path="also-stale.txt">cancelled</softn-file>'));
    await secondRun;

    expect(useVFSStore.getState().files.has('also-stale.txt')).toBe(false);
    expect(useAIStore.getState().agentState).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// What the model was shown is what it may replace.
//
// The prompt shows at most 6,000 characters of a file while the instructions
// ask for complete replacement files, so a model editing the head of a long
// file returned the head and the tail was gone. Pinned here: a whole-file
// reply for a file shown truncated is refused and the tail survives; the
// model can ask for the file whole and then replace it; a file changed while
// the request was in flight is not overwritten from old content.
// ---------------------------------------------------------------------------

const HEAD = '// head of the file\nfunction start() { return 1 }\n';
const FILLER = '// filler line to push the tail past the per-file cap\n'.repeat(240);
const TAIL = '\n// SENTINEL-TAIL-7f3a\nfunction needed() { return "still here" }\n';
const LONG = HEAD + FILLER + TAIL;

function lastToolCalls() {
  const msgs = useAIStore.getState().messages;
  return msgs[msgs.length - 1]?.toolCalls ?? [];
}

describe('the record of what was supplied', () => {
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
    expect(text).toContain('<softn-read path="logic/app.logic" />');
    expect(text).not.toContain('SENTINEL-TAIL-7f3a');
    // Asked for whole, it is whole, and says so.
    const whole = buildFileContents(files, 6000, 80000, new Set(['logic/app.logic']));
    expect(whole.supplied.get('logic/app.logic')?.complete).toBe(true);
    expect(whole.text).toContain('SENTINEL-TAIL-7f3a');
  });

  it('lists a file past the overall budget by name rather than showing it', () => {
    const files = new Map<string, VFSFile>();
    for (let i = 0; i < 20; i++) files.set(`ui/p${i}.ui`, { path: `ui/p${i}.ui`, content: 'x'.repeat(5000), mimeType: 't', lastModified: 1, lastModifiedBy: 'user', version: 1 });
    const { text, supplied } = buildFileContents(files);
    expect(supplied.size).toBeLessThan(20);
    expect(text).toContain('Files not shown');
    expect(supplied.has('ui/p19.ui')).toBe(false);
  });

  it('parses read requests and strips them from the text', () => {
    const parsed = parseAIResponse('I need to see it first.\n<softn-read path="logic/app.logic" />\n<softn-read path="logic/app.logic" />');
    expect(parsed.reads).toEqual([{ path: 'logic/app.logic' }]);
    expect(parsed.text).toBe('I need to see it first.');
  });
});

describe('checkWrite', () => {
  const file = (version: number): VFSFile => ({ path: 'a', content: 'c', mimeType: 't', lastModified: 1, lastModifiedBy: 'user', version });
  it('allows a new file, refuses partial, unseen and stale', () => {
    const supplied = new Map([
      ['a', { path: 'a', complete: false, version: 1, shown: 6000, total: 9000 }],
      ['b', { path: 'b', complete: true, version: 2, shown: 10, total: 10 }],
    ]);
    expect(checkWrite('new', supplied, undefined)).toBeNull();
    expect(checkWrite('a', supplied, file(1))).toEqual({ kind: 'partial', shown: 6000, total: 9000 });
    expect(checkWrite('c', supplied, file(1))).toEqual({ kind: 'unseen' });
    expect(checkWrite('b', supplied, file(3))).toEqual({ kind: 'stale', suppliedVersion: 2, currentVersion: 3 });
    expect(checkWrite('b', supplied, file(2))).toBeNull();
  });
});

describe('a turn against a long file', () => {
  beforeEach(() => {
    useVFSStore.getState().hydrateFiles([
      { path: 'logic/app.logic', content: LONG },
      { path: 'ui/main.ui', content: '<App/>' },
    ]);
  });

  it('refuses a whole-file replacement of a file shown truncated, so the tail survives', async () => {
    // A provider that does what a model does with a truncated file: returns the part it saw, edited.
    vi.mocked(sendAIRequest).mockImplementationOnce(async () =>
      reply(`Renamed start.\n<softn-file path="logic/app.logic">${LONG.slice(0, 6000).replace('start', 'begin')}</softn-file>`),
    );
    await runAgentTurn();
    const content = useVFSStore.getState().readFile('logic/app.logic') as string;
    expect(content).toContain('SENTINEL-TAIL-7f3a');
    expect(content).toContain('function needed()');
    expect(content).toBe(LONG);
    const calls = lastToolCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe('error');
    expect(calls[0].result).toMatch(/truncated/);
    expect(useAIStore.getState().agentState).toBe('idle');
  });

  it('supplies the file whole when asked, then accepts the replacement, naming the version it was built on', async () => {
    const systems: string[] = [];
    vi.mocked(sendAIRequest)
      .mockImplementationOnce(async (_p, req) => {
        systems.push(req.system);
        return reply('Let me see the whole file.\n<softn-read path="logic/app.logic" />');
      })
      .mockImplementationOnce(async (_p, req) => {
        systems.push(req.system);
        const handed = req.messages[req.messages.length - 1];
        expect(handed.role).toBe('user');
        expect(handed.content).toContain('SENTINEL-TAIL-7f3a');
        return reply(`Done.\n<softn-file path="logic/app.logic">${LONG.replace('start', 'begin')}</softn-file>`);
      });
    await runAgentTurn();
    expect(systems[0]).toContain('TRUNCATED');
    expect(systems[1]).toContain('logic/app.logic (complete,');
    const content = useVFSStore.getState().readFile('logic/app.logic') as string;
    expect(content).toContain('function begin()');
    expect(content).toContain('SENTINEL-TAIL-7f3a');
    const calls = lastToolCalls();
    expect(calls.map((c) => [c.tool, c.status])).toEqual([
      ['readFile', 'success'],
      ['updateFile', 'success'],
    ]);
    expect(useAIStore.getState().messages.at(-1)?.content).toContain('Done.');
  });

  it('refuses to overwrite a file edited while the request was in flight', async () => {
    const pending = deferred<Response>();
    vi.mocked(sendAIRequest).mockReturnValueOnce(pending.promise);
    const run = runAgentTurn();
    // The person edits the short file while the model is thinking.
    useVFSStore.getState().updateFile('ui/main.ui', '<App theme="dark"/>', 'user');
    pending.resolve(reply('<softn-file path="ui/main.ui"><App title="from old content"/></softn-file>'));
    await run;
    expect(useVFSStore.getState().readFile('ui/main.ui')).toBe('<App theme="dark"/>');
    expect(lastToolCalls()[0].result).toMatch(/changed while the request was in flight/);
  });

  it('refuses a reply built on a file that was deleted and re-created while the request was in flight', async () => {
    // STU-06 known gap: a re-created file restarted at version 1, the same
    // number the reply was built on, so the stale check passed and the
    // reply replaced content the model had never seen.
    const pending = deferred<Response>();
    vi.mocked(sendAIRequest).mockReturnValueOnce(pending.promise);
    const run = runAgentTurn();
    useVFSStore.getState().deleteFile('ui/main.ui', 'user');
    useVFSStore.getState().createFile('ui/main.ui', '<App theme="recreated"/>', 'user');
    pending.resolve(reply('<softn-file path="ui/main.ui"><App title="from the deleted content"/></softn-file>'));
    await run;
    expect(useVFSStore.getState().readFile('ui/main.ui')).toBe('<App theme="recreated"/>');
    expect(lastToolCalls()[0].status).toBe('error');
    expect(lastToolCalls()[0].result).toMatch(/changed while the request was in flight/);
  });

  it('refuses a deletion built on a version the re-created file no longer has', async () => {
    const pending = deferred<Response>();
    vi.mocked(sendAIRequest).mockReturnValueOnce(pending.promise);
    const run = runAgentTurn();
    useVFSStore.getState().deleteFile('ui/main.ui', 'user');
    useVFSStore.getState().createFile('ui/main.ui', '<App theme="recreated"/>', 'user');
    pending.resolve(reply('<softn-delete path="ui/main.ui" />'));
    await run;
    expect(useVFSStore.getState().readFile('ui/main.ui')).toBe('<App theme="recreated"/>');
    expect(lastToolCalls()[0].status).toBe('error');
  });

  it('still creates a new file and updates a short file it saw whole', async () => {
    vi.mocked(sendAIRequest).mockImplementationOnce(async () =>
      reply('<softn-file path="ui/new.ui"><Text>new</Text></softn-file><softn-file path="ui/main.ui"><App theme="dark"/></softn-file>'),
    );
    await runAgentTurn();
    expect(useVFSStore.getState().readFile('ui/new.ui')).toBe('<Text>new</Text>');
    expect(useVFSStore.getState().readFile('ui/main.ui')).toBe('<App theme="dark"/>');
    expect(lastToolCalls().every((c) => c.status === 'success')).toBe(true);
  });

  it('stops answering read requests after a bounded number of rounds', async () => {
    vi.mocked(sendAIRequest).mockImplementation(async () => reply('<softn-read path="logic/app.logic" /><softn-read path="ui/nothere.ui" />'));
    await runAgentTurn();
    expect(vi.mocked(sendAIRequest).mock.calls.length).toBeLessThanOrEqual(3);
    expect(useAIStore.getState().agentState).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// A reply is applied as one transaction, or not at all.
//
// Operations used to go into the VFS one by one as they were parsed, so a
// reply with one refused or malformed operation left the project half
// changed, a deletion never marked the project dirty, and there was no unit
// to undo. Pinned here: a manual edit made after the request began is a
// conflict that holds the whole batch; one invalid operation holds the whole
// batch; a deletion-only turn is dirty and reversible; a reply cut off at
// the output limit is never applied; and a turn's transaction can be reverted
// by its id.
// ---------------------------------------------------------------------------

describe('a turn as a transaction', () => {
  const lastMessage = () => useAIStore.getState().messages.at(-1)!;

  beforeEach(() => {
    useVFSStore.getState().hydrateFiles([
      { path: 'ui/main.ui', content: '<App>\n  <Text>one</Text>\n</App>' },
      { path: 'ui/about.ui', content: '<About/>' },
      { path: 'logic/app.logic', content: 'let a = 1' },
      { path: 'assets/logo.png', content: new Uint8Array([1, 2, 3]) },
    ]);
  });

  it('reports a manual edit made after the request as a conflict and commits nothing from the batch', async () => {
    const pending = deferred<Response>();
    vi.mocked(sendAIRequest).mockReturnValueOnce(pending.promise);
    const run = runAgentTurn();
    useVFSStore.getState().updateFile('ui/about.ui', '<About edited="by hand"/>', 'user');
    const historyBefore = useVFSStore.getState().history.length;
    pending.resolve(
      reply(
        '<softn-file path="ui/main.ui"><App>new</App></softn-file>' +
          '<softn-file path="ui/about.ui"><About from="old"/></softn-file>' +
          '<softn-delete path="logic/app.logic" />',
      ),
    );
    await run;
    const vfs = useVFSStore.getState();
    expect(vfs.readFile('ui/main.ui')).toBe('<App>\n  <Text>one</Text>\n</App>');
    expect(vfs.readFile('ui/about.ui')).toBe('<About edited="by hand"/>');
    expect(vfs.files.has('logic/app.logic')).toBe(true);
    expect(vfs.history.length).toBe(historyBefore);
    const calls = lastToolCalls();
    expect(calls.every((c) => c.status === 'error')).toBe(true);
    expect(calls.find((c) => c.args.path === 'ui/about.ui')?.result).toMatch(/changed while the request was in flight/);
    expect(calls.find((c) => c.args.path === 'ui/main.ui')?.result).toMatch(/held back/i);
    expect(lastMessage().transactionId).toBeUndefined();
    expect(useWorkspaceStore.getState().isDirty).toBe(false);
  });

  it('commits nothing when one operation in the batch is invalid', async () => {
    vi.mocked(sendAIRequest).mockImplementationOnce(async () =>
      reply(
        '<softn-file path="ui/main.ui"><App>new</App></softn-file>' +
          '<softn-file path="../escape.ui"><App/></softn-file>' +
          '<softn-file path="ui/new.ui"><New/></softn-file>',
      ),
    );
    await runAgentTurn();
    const vfs = useVFSStore.getState();
    expect(vfs.readFile('ui/main.ui')).toBe('<App>\n  <Text>one</Text>\n</App>');
    expect(vfs.files.has('ui/new.ui')).toBe(false);
    expect(vfs.files.has('../escape.ui')).toBe(false);
    expect(vfs.history).toEqual([]);
    const calls = lastToolCalls();
    expect(calls).toHaveLength(3);
    expect(calls.find((c) => c.args.path === '../escape.ui')?.result).toMatch(/path/i);
  });

  it('commits nothing when a reply names one path twice, or deletes and updates the same path', async () => {
    vi.mocked(sendAIRequest).mockImplementationOnce(async () =>
      reply('<softn-file path="ui/main.ui"><App>a</App></softn-file><softn-file path="UI\\Main.ui"><App>b</App></softn-file>'),
    );
    await runAgentTurn();
    expect(useVFSStore.getState().readFile('ui/main.ui')).toBe('<App>\n  <Text>one</Text>\n</App>');
    expect(useVFSStore.getState().files.size).toBe(4);
    expect(lastToolCalls().some((c) => /more than once/i.test(c.result ?? ''))).toBe(true);

    vi.mocked(sendAIRequest).mockImplementationOnce(async () =>
      reply('<softn-file path="ui/about.ui"><About v="2"/></softn-file><softn-delete path="ui/about.ui" />'),
    );
    await runAgentTurn();
    expect(useVFSStore.getState().readFile('ui/about.ui')).toBe('<About/>');
    expect(useVFSStore.getState().history).toEqual([]);
  });

  it('refuses to write private editor state however it is spelled', async () => {
    vi.mocked(sendAIRequest).mockImplementationOnce(async () => reply('<softn-file path="Builder\\blueprint.json">{}</softn-file>'));
    await runAgentTurn();
    expect(useVFSStore.getState().files.size).toBe(4);
    expect(lastToolCalls()[0].result).toMatch(/private/i);
  });

  it('a deletion-only turn marks the project dirty and can be reverted', async () => {
    vi.mocked(sendAIRequest).mockImplementationOnce(async () => reply('Removed it.\n<softn-delete path="assets/logo.png" />'));
    await runAgentTurn();
    expect(useVFSStore.getState().files.has('assets/logo.png')).toBe(false);
    expect(useWorkspaceStore.getState().isDirty).toBe(true);
    const id = lastMessage().transactionId;
    expect(id).toBeTruthy();
    expect(useVFSStore.getState().history.map((e) => e.transactionId)).toEqual([id]);
    const result = useVFSStore.getState().revertTransaction(id!);
    expect(result.ok).toBe(true);
    expect(useVFSStore.getState().readFile('assets/logo.png')).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('commits a valid batch as one transaction with a diff summary per file, undone as a unit', async () => {
    vi.mocked(sendAIRequest).mockImplementationOnce(async () =>
      reply(
        '<softn-file path="ui/new.ui"><New/></softn-file>' +
          '<softn-file path="ui/main.ui"><App>\n  <Text>one</Text>\n  <Text>two</Text>\n</App></softn-file>' +
          '<softn-delete path="ui/about.ui" />',
      ),
    );
    await runAgentTurn();
    const vfs = useVFSStore.getState();
    expect(vfs.files.has('ui/new.ui')).toBe(true);
    expect(vfs.files.has('ui/about.ui')).toBe(false);
    const id = lastMessage().transactionId!;
    expect(vfs.history.map((e) => e.transactionId)).toEqual([id, id, id]);
    const calls = lastToolCalls();
    expect(calls.map((c) => [c.tool, c.status])).toEqual([
      ['createFile', 'success'],
      ['updateFile', 'success'],
      ['deleteFile', 'success'],
    ]);
    expect(calls[1].result).toMatch(/\+1 .*0 line/);
    expect(useAIStore.getState().filesChanged).toBe(3);
    useVFSStore.getState().undoLast();
    expect(useVFSStore.getState().files.has('ui/new.ui')).toBe(false);
    expect(useVFSStore.getState().readFile('ui/about.ui')).toBe('<About/>');
    expect(useVFSStore.getState().readFile('ui/main.ui')).toBe('<App>\n  <Text>one</Text>\n</App>');
  });

  it('never applies a reply that was cut off at the output limit', async () => {
    vi.mocked(sendAIRequest).mockImplementationOnce(async () => reply('Here.\n<softn-file path="ui/main.ui"><App>complete-looking</App></softn-file>', 'truncated'));
    await runAgentTurn();
    expect(useVFSStore.getState().readFile('ui/main.ui')).toBe('<App>\n  <Text>one</Text>\n</App>');
    expect(useVFSStore.getState().history).toEqual([]);
    expect(lastToolCalls().some((c) => c.status === 'error' && /output limit/i.test(c.result ?? ''))).toBe(true);
    expect(useAIStore.getState().lastFailure?.kind).toBe('truncated');
    expect(useAIStore.getState().agentState).toBe('idle');
  });

  it('refuses to send a request the remaining budget cannot cover', async () => {
    useAIStore.setState({ tokenBudget: 1000, tokensUsed: 0 });
    await runAgentTurn();
    expect(vi.mocked(sendAIRequest)).not.toHaveBeenCalled();
    expect(lastMessage().content).toMatch(/budget/i);
    expect(useAIStore.getState().lastFailure?.kind).toBe('budget');
    expect(useAIStore.getState().agentState).toBe('idle');
  });

  it('reports a timeout and a rate limit as distinct, recoverable failures', async () => {
    vi.mocked(sendAIRequest).mockRejectedValueOnce(new AIProviderError('timeout', 'The provider did not answer within 120 s.'));
    await runAgentTurn();
    expect(useAIStore.getState().lastFailure?.kind).toBe('timeout');
    expect(lastMessage().content).toMatch(/did not answer/);
    useAIStore.setState({ agentState: 'idle' });

    vi.mocked(sendAIRequest).mockRejectedValueOnce(new AIProviderError('rate-limited', 'Rate limited.', { status: 429, retryAfterMs: 7000 }));
    await runAgentTurn();
    expect(useAIStore.getState().lastFailure).toMatchObject({ kind: 'rate-limited', retryAfterMs: 7000 });
    expect(lastMessage().content).toMatch(/7 s/);
    useAIStore.setState({ agentState: 'idle' });
  });
});
