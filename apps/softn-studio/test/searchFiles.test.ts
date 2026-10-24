/**
 * `search_files` runs the model's pattern where a pattern that never ends
 * can be ended. On the page, `^(\w+\s?)*$` over a line of thirty characters
 * held Studio, its Stop button and its autosave, for seconds, doubling with
 * each character more.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchLines, searchProject } from '../src/lib/agent/searchLines';

const FILES: Array<[string, string]> = [
  ['logic/main.logic', 'let count = 0\nfunction add() { count += 1 }'],
  ['ui/main.ui', '<App>\n  <Text>{count}</Text>\n</App>'],
];

/** A worker that answers as the real one does, or never. */
function fakeWorker(answers: boolean) {
  const made: Array<{ terminated: boolean }> = [];
  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    terminated = false;
    constructor(public url: URL, public options: unknown) {
      made.push(this);
    }
    postMessage(data: { pattern: string; flags: string; files: Array<[string, string]> }) {
      if (answers) setTimeout(() => this.onmessage?.({ data: searchLines(data.pattern, data.flags, data.files) }), 0);
    }
    terminate() {
      this.terminated = true;
    }
  }
  vi.stubGlobal('Worker', FakeWorker);
  return made;
}

afterEach(() => vi.unstubAllGlobals());

describe('a search', () => {
  it('lists the matching lines, in a worker of its own that is ended once it answers', async () => {
    const made = fakeWorker(true);
    const found = await searchProject('count', 'i', FILES);
    expect(found).toEqual({ hits: ['logic/main.logic:1: let count = 0', 'logic/main.logic:2: function add() { count += 1 }', 'ui/main.ui:2: <Text>{count}</Text>'], more: 0 });
    expect(made).toHaveLength(1);
    expect(made[0].terminated).toBe(true);
    expect(String((made[0] as unknown as { url: URL }).url)).toMatch(/searchWorker\.ts$/);
  });

  it('is ended at its deadline, and says so, where the pattern would run on', async () => {
    const made = fakeWorker(false);
    const found = await searchProject('^(\\w+\\s?)*$', 'i', FILES, 20);
    expect(found).toEqual({ timedOut: true });
    expect(made[0].terminated).toBe(true);
  });

  it('runs where it is called where there are no workers', async () => {
    expect(typeof Worker).toBe('undefined');
    expect((await searchProject('App', 'i', FILES)) as unknown).toMatchObject({ hits: ['ui/main.ui:1: <App>', 'ui/main.ui:3: </App>'] });
  });
});

describe('search_files', () => {
  it('tells the model a pattern was stopped, and how to search instead', async () => {
    fakeWorker(false);
    vi.useFakeTimers();
    try {
      const { executeTool } = await import('../src/lib/agent/executeTool');
      const { useVFSStore } = await import('../src/stores/vfsStore');
      useVFSStore.getState().reset();
      useVFSStore.getState().hydrateFiles(FILES.map(([path, content]) => ({ path, content })));
      const outcome = executeTool({ id: 'c1', name: 'search_files', input: { pattern: '^(\\w+\\s?)*$' } }, { seen: new Map() } as never);
      await vi.advanceTimersByTimeAsync(3100);
      const result = await outcome;
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/took longer than 3 seconds.*was stopped/s);
      expect(result.content).toMatch(/regex: false/);
    } finally {
      vi.useRealTimers();
    }
  });
});
