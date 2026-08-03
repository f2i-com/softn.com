import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/aiProvider', () => ({
  sendAIRequest: vi.fn(),
}));

import { sendAIRequest } from '../src/lib/aiProvider';
import { abortAgentTurn, runAgentTurn } from '../src/lib/agentOrchestrator';
import { useAIStore } from '../src/stores/aiStore';
import { useVFSStore } from '../src/stores/vfsStore';
import { useWorkspaceStore } from '../src/stores/workspaceStore';

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
