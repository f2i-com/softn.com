import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/aiProvider', () => ({
  sendAIRequest: vi.fn(),
}));

import { sendAIRequest } from '../src/lib/aiProvider';
import { abortAgentTurn, buildFileContents, checkWrite, parseAIResponse, runAgentTurn } from '../src/lib/agentOrchestrator';
import { useAIStore } from '../src/stores/aiStore';
import { useVFSStore } from '../src/stores/vfsStore';
import { useWorkspaceStore } from '../src/stores/workspaceStore';
import type { VFSFile } from '../src/types/studio';

type Response = Awaited<ReturnType<typeof sendAIRequest>>;

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
    filesChanged: 0,
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
    first.resolve({
      content: '<softn-file path="stale.txt">old project</softn-file>',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    await firstRun;

    expect(useVFSStore.getState().files.has('stale.txt')).toBe(false);
    expect(useAIStore.getState().agentState).toBe('building');
    expect(secondSignal.aborted).toBe(false);

    // The replacement remains independently cancellable after the first
    // turn's finally block has run.
    abortAgentTurn();
    expect(secondSignal.aborted).toBe(true);

    second.resolve({
      content: '<softn-file path="also-stale.txt">cancelled</softn-file>',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
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
    vi.mocked(sendAIRequest).mockImplementationOnce(async () => ({
      content: `Renamed start.\n<softn-file path="logic/app.logic">${LONG.slice(0, 6000).replace('start', 'begin')}</softn-file>`,
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
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
        return { content: 'Let me see the whole file.\n<softn-read path="logic/app.logic" />', usage: { inputTokens: 1, outputTokens: 1 } };
      })
      .mockImplementationOnce(async (_p, req) => {
        systems.push(req.system);
        const handed = req.messages[req.messages.length - 1];
        expect(handed.role).toBe('user');
        expect(handed.content).toContain('SENTINEL-TAIL-7f3a');
        return { content: `Done.\n<softn-file path="logic/app.logic">${LONG.replace('start', 'begin')}</softn-file>`, usage: { inputTokens: 1, outputTokens: 1 } };
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
    pending.resolve({ content: '<softn-file path="ui/main.ui"><App title="from old content"/></softn-file>', usage: { inputTokens: 1, outputTokens: 1 } });
    await run;
    expect(useVFSStore.getState().readFile('ui/main.ui')).toBe('<App theme="dark"/>');
    expect(lastToolCalls()[0].result).toMatch(/changed while the request was in flight/);
  });

  it('still creates a new file and updates a short file it saw whole', async () => {
    vi.mocked(sendAIRequest).mockImplementationOnce(async () => ({
      content: '<softn-file path="ui/new.ui"><Text>new</Text></softn-file><softn-file path="ui/main.ui"><App theme="dark"/></softn-file>',
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    await runAgentTurn();
    expect(useVFSStore.getState().readFile('ui/new.ui')).toBe('<Text>new</Text>');
    expect(useVFSStore.getState().readFile('ui/main.ui')).toBe('<App theme="dark"/>');
    expect(lastToolCalls().every((c) => c.status === 'success')).toBe(true);
  });

  it('stops answering read requests after a bounded number of rounds', async () => {
    vi.mocked(sendAIRequest).mockImplementation(async () => ({ content: '<softn-read path="logic/app.logic" /><softn-read path="ui/nothere.ui" />', usage: { inputTokens: 1, outputTokens: 1 } }));
    await runAgentTurn();
    expect(vi.mocked(sendAIRequest).mock.calls.length).toBeLessThanOrEqual(3);
    expect(useAIStore.getState().agentState).toBe('idle');
  });
});
