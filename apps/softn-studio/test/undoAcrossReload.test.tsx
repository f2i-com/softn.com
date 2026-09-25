/** @vitest-environment jsdom */
/**
 * Undo and Revert run after the page reloads.
 *
 * The VFS undo history is memory only, and runs are now continued after a
 * reload — so a run's Undo and Revert run used to do nothing there. The undo
 * journal (lib/undoJournal.ts) is saved with the project: here a run is made,
 * the project is saved to (fake) IndexedDB, and a fresh set of modules opens
 * it, as a reloaded page does. Pinned: a step can be undone and the run
 * reverted from the saved journal; a later edit — made before the reload or
 * after it — refuses the revert and changes nothing; the saved journal is
 * bounded, keeps text only, and says why a step it could not keep cannot be
 * undone; a project saved before the journal existed opens with Undo
 * explained rather than offered.
 */

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeIndexedDB } from '@softn/test-utils/fake-indexeddb';
import { startAgentRun, stepUndoState, stepUndoUnavailable, turnRevertState } from '../src/lib/agent/runAgent';
import { RunTimeline } from '../src/components/ai/RunTimeline';
import type { AgentEnvironment } from '../src/lib/agent/appCheck';
import { collectProjectRecord } from '../src/lib/projectSession';
import { loadProjectRecord, saveProjectRecord, type ProjectRecord } from '../src/lib/persistence';
import {
  MAX_JOURNAL_ENTRIES,
  MAX_PERSISTED_CHARS,
  MAX_PERSISTED_ENTRY_CHARS,
  boundJournal,
  persistJournal,
  readPersistedJournal,
  type UndoEntry,
} from '../src/lib/undoJournal';
import { useVFSStore } from '../src/stores/vfsStore';
import { useAIStore } from '../src/stores/aiStore';
import { useWorkspaceStore } from '../src/stores/workspaceStore';
import { ANTHROPIC, APP, assertScriptsPassed, fakeProvider, lastRun, resetAgent, say, seedApp } from './helpers/agentHarness';

/** The app check is not what is under test here. */
const quiet: AgentEnvironment = {
  checkApp: async () => ({ ok: true, errors: [], warnings: [], renderedHeadless: false }),
  inspectPreview: async () => ({ ok: true, text: '' }),
  runFunction: async () => ({ ok: true, text: '' }),
};

const ONE = '<App><Text>1</Text></App>';

beforeEach(() => {
  installFakeIndexedDB();
  resetAgent(ANTHROPIC, quiet);
  seedApp();
  useWorkspaceStore.setState({ projectId: 'undo-project', projectName: 'Tasks' });
});
afterEach(() => {
  assertScriptsPassed();
  resetAgent();
  delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
});

/** Three steps on three files: a new page, an edit to the logic, an edit to the main page. */
async function threeStepRun(): Promise<void> {
  fakeProvider('anthropic', [
    { calls: [{ name: 'write_file', input: { path: 'ui/one.ui', content: ONE } }] },
    { calls: [{ name: 'read_file', input: { path: 'logic/main.logic' } }, { name: 'edit_file', input: { path: 'logic/main.logic', old_string: 'count = 0', new_string: 'count = 5' } }] },
    { calls: [{ name: 'read_file', input: { path: 'ui/main.ui' } }, { name: 'edit_file', input: { path: 'ui/main.ui', old_string: '>Tasks<', new_string: '>Chores<' } }] },
    { calls: [{ name: 'finish', input: { summary: 'Three changes.' } }] },
  ]);
  say('Three changes');
  await startAgentRun();
  expect(lastRun().run.status).toBe('finished');
  expect(lastRun().run.transactions).toHaveLength(3);
}

/** Save what the page holds, then open it in fresh modules — a reload. */
async function saveAndReload(mutate?: (record: ProjectRecord) => void) {
  const record = collectProjectRecord(1)!;
  mutate?.(record);
  expect((await saveProjectRecord(record)).ok).toBe(true);
  const loaded = (await loadProjectRecord('undo-project'))!;
  expect(loaded).toBeTruthy();
  vi.resetModules();
  const fresh = {
    session: await import('../src/lib/projectSession'),
    agent: await import('../src/lib/agent/runAgent'),
    vfs: (await import('../src/stores/vfsStore')).useVFSStore,
    ai: (await import('../src/stores/aiStore')).useAIStore,
    Timeline: (await import('../src/components/ai/RunTimeline')).RunTimeline,
    Chat: (await import('../src/components/ai/AIChat')).AIChat,
  };
  fresh.session.applyProjectRecord(loaded);
  // Nothing of the old page's memory came across: the history is empty.
  expect(fresh.vfs.getState().history).toEqual([]);
  const message = () => fresh.ai.getState().messages.find((m) => m.run)!;
  const read = (path: string) => fresh.vfs.getState().readFile(path);
  const entry = (name: string, subject: string) => message().run!.entries.find((e) => e.kind === 'tool' && e.name === name && e.subject === subject)!;
  return { fresh, message, read, entry, loaded };
}

describe('after a reload', () => {
  it('undoes one step, then reverts the rest of the run', async () => {
    await threeStepRun();
    const { fresh, message, read, entry } = await saveAndReload();
    expect(read('logic/main.logic')).toContain('count = 5');

    const step = entry('edit_file', 'logic/main.logic');
    expect(fresh.agent.stepUndoUnavailable(step)).toBeNull();
    expect(fresh.agent.undoAgentStep(message().run!.id, message().id, step.id)).toEqual({ ok: true, paths: ['logic/main.logic'] });
    expect(read('logic/main.logic')).toBe(APP.logic);
    expect(read('ui/main.ui')).toContain('Chores');

    const reverted = fresh.agent.revertAgentRun(message().id);
    expect(reverted).toMatchObject({ ok: true });
    expect(reverted.ok && [...reverted.paths].sort()).toEqual(['ui/main.ui', 'ui/one.ui']);
    expect(read('ui/one.ui')).toBeNull();
    expect(read('ui/main.ui')).toBe(APP.ui);
    expect(read('logic/main.logic')).toBe(APP.logic);
    expect(message().run!.reverted).toBe(true);
    // The revert is itself one change, which the person can undo.
    fresh.vfs.getState().undoLast();
    expect(read('ui/one.ui')).toBe(ONE);
    expect(read('ui/main.ui')).toContain('Chores');
  });

  it('refuses to revert when a file was edited after the run, before or after the reload, and changes nothing', async () => {
    await threeStepRun();
    // Edited by the person after the run, then saved: the reloaded page has no history of it.
    useVFSStore.getState().updateFile('ui/main.ui', APP.ui.replace('Tasks', 'Mine'), 'user');
    const { fresh, message, read, entry } = await saveAndReload();

    const refused = fresh.agent.revertAgentRun(message().id);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : refused.reason).toBe('ui/main.ui was edited after this run. Undo that edit first, or revert steps one by one.');
    expect(read('ui/one.ui')).toBe(ONE);
    expect(read('logic/main.logic')).toContain('count = 5');
    expect(message().run!.reverted).toBeFalsy();

    // A step on a file nobody else touched can still be undone on its own.
    const logic = entry('edit_file', 'logic/main.logic');
    expect(fresh.agent.undoAgentStep(message().run!.id, message().id, logic.id).ok).toBe(true);
    // The step on the edited file cannot.
    const main = entry('edit_file', 'ui/main.ui');
    const blocked = fresh.agent.undoAgentStep(message().run!.id, message().id, main.id);
    expect(blocked.ok ? '' : blocked.reason).toBe('ui/main.ui was edited after this step. Undo that edit first, or revert by hand.');

    // An edit after the reload is caught the same way; putting the file back as the run left it lets the revert through.
    fresh.vfs.getState().updateFile('ui/main.ui', 'something else', 'user');
    expect(fresh.agent.revertAgentRun(message().id).ok).toBe(false);
    fresh.vfs.getState().updateFile('ui/main.ui', APP.ui.replace('Tasks', 'Chores'), 'user');
    expect(fresh.agent.revertAgentRun(message().id).ok).toBe(true);
    expect(read('ui/main.ui')).toBe(APP.ui);
    expect(read('ui/one.ui')).toBeNull();
  });

  it('shows Undo on each step and Revert run in the timeline, and they work', async () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await threeStepRun();
    const { fresh, message, read } = await saveAndReload();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const view = () => <fresh.Timeline message={message()} />;
    try {
      act(() => root.render(view()));
      const undos = () => [...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Undo');
      expect(undos()).toHaveLength(3);
      expect(container.textContent).not.toContain('no undo');
      act(() => undos()[0].click());
      act(() => root.render(view()));
      expect(read('ui/one.ui')).toBeNull();
      expect(undos()).toHaveLength(2);
      const revert = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Revert run'))!;
      act(() => revert.click());
      act(() => root.render(view()));
      expect(read('ui/main.ui')).toBe(APP.ui);
      expect(read('logic/main.logic')).toBe(APP.logic);
      expect(container.textContent).toContain('This run was reverted.');
      expect(undos()).toHaveLength(0);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('opens a project saved before the journal with Undo explained, not offered', async () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await threeStepRun();
    const { fresh, message, read, entry } = await saveAndReload((record) => {
      delete record.undo;
    });
    const step = entry('edit_file', 'logic/main.logic');
    expect(fresh.agent.stepUndoUnavailable(step)).toMatch(/no undo data was saved for this change/);
    const refused = fresh.agent.revertAgentRun(message().id);
    expect(refused.ok ? '' : refused.reason).toMatch(/^Revert run isn't available: one of its steps can't be undone from here/);
    expect(read('ui/one.ui')).toBe(ONE);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      act(() => root.render(<fresh.Timeline message={message()} />));
      expect([...container.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Undo')).toBe(false);
      expect([...container.querySelectorAll('button')].some((b) => b.textContent?.includes('Revert run'))).toBe(false);
      expect(container.querySelectorAll('.st-run-badge.is-muted')).toHaveLength(3);
      expect(container.textContent).toContain("Revert run isn't available");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('opens a project whose saved journal is malformed, without its undo data', async () => {
    await threeStepRun();
    const { fresh, read } = await saveAndReload((record) => {
      (record as unknown as { undo: unknown }).undo = { version: 1, entries: [{ id: 3 }, 'x', { id: 'a', at: 1, changes: [{ path: 'p', before: { kind: 'text', prefix: 9, suffix: 9, middle: '', fingerprint: { hash: 'h', length: 1 } }, after: null }] }] };
    });
    expect(read('ui/one.ui')).toBe(ONE);
    expect(fresh.vfs.getState().journal).toEqual([]);
  });
});

describe('what is saved', () => {
  it('keeps an edit to a long file as the lines that changed, and in-session binary changes are not saved', async () => {
    const long = Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join('\n');
    useVFSStore.getState().createFile('data/long.txt', long, 'user');
    useVFSStore.getState().updateFile('data/long.txt', long.replace('line 2500\n', 'line 2500 changed\n'), 'ai');
    useVFSStore.getState().createFile('assets/pic.png', new Uint8Array([1, 2, 3]), 'user');
    useVFSStore.getState().updateFile('assets/pic.png', new Uint8Array([4, 5, 6]), 'ai');
    const saved = persistJournal(useVFSStore.getState().journal);
    expect(saved.entries).toHaveLength(2);
    expect(JSON.stringify(saved.entries[0]).length).toBeLessThan(500);
    expect(saved.entries[1]).toMatchObject({ lost: 'binary', changes: [] });
    expect(JSON.stringify(saved)).not.toContain('Uint8Array');
    // In the session the binary change is still revertible from memory.
    expect(useVFSStore.getState().revertJournaled([saved.entries[1].id]).ok).toBe(true);
    expect([...(useVFSStore.getState().readFile('assets/pic.png') as Uint8Array)]).toEqual([1, 2, 3]);
  });

  it('keeps the newest entries within the cap and marks older and oversized ones as lost, with the reason shown', () => {
    const chunk = 'x'.repeat(100_000);
    const entries: UndoEntry[] = [];
    for (let i = 0; i < 15; i++) {
      entries.push({ id: `t${i}`, at: i, changes: [{ path: `f${i}.txt`, before: { kind: 'text', prefix: 0, suffix: 0, middle: chunk, fingerprint: { hash: 'h', length: chunk.length } }, after: null }] });
    }
    const huge = 'y'.repeat(MAX_PERSISTED_ENTRY_CHARS + 1);
    entries.push({ id: 'big', at: 99, changes: [{ path: 'big.txt', before: { kind: 'text', prefix: 0, suffix: 0, middle: huge, fingerprint: { hash: 'h', length: huge.length } }, after: null }] });
    const saved = persistJournal(entries);
    const kept = saved.entries.filter((e) => !e.lost).map((e) => e.id);
    expect(kept).toEqual(['t5', 't6', 't7', 't8', 't9', 't10', 't11', 't12', 't13', 't14']);
    expect(kept.length * chunk.length).toBeLessThanOrEqual(MAX_PERSISTED_CHARS);
    expect(saved.entries.find((e) => e.id === 't4')).toMatchObject({ lost: 'trimmed' });
    expect(saved.entries.find((e) => e.id === 'big')).toMatchObject({ lost: 'too-large' });

    // After a reload, a trimmed step says why; the kept ones still undo.
    useVFSStore.getState().hydrateJournal(readPersistedJournal(JSON.parse(JSON.stringify(saved))));
    const row = (id: string) => ({ kind: 'tool' as const, id, name: 'write_file', subject: '', status: 'ok' as const, result: '', at: 0, transactionId: id });
    expect(stepUndoUnavailable(row('t4'))).toMatch(/only the newest changes keep their undo data/);
    expect(stepUndoUnavailable(row('big'))).toMatch(/too large/);
    expect(stepUndoUnavailable(row('t14'))).toBeNull();
  });

  it('bounds the journal in memory by count, keeping ids of the trimmed', () => {
    for (let i = 0; i < MAX_JOURNAL_ENTRIES + 5; i++) useVFSStore.getState().applyTransaction([{ op: 'create', path: `ui/p${i}.ui`, content: `<Text>${i}</Text>` }], 'ai', `x${i}`);
    const journal = useVFSStore.getState().journal;
    expect(journal.filter((e) => !e.lost)).toHaveLength(MAX_JOURNAL_ENTRIES);
    expect(journal.slice(0, 5).every((e) => e.lost === 'trimmed')).toBe(true);
    expect(boundJournal(journal)).toBe(journal);
    // The person's own edits are not journalled: the history covers them in the session.
    useVFSStore.getState().createFile('ui/mine.ui', '<Text/>', 'user');
    expect(useVFSStore.getState().journal).toBe(journal);
  });
});

/** Render `view` into a fresh container, run `body`, and clean up. */
function mount(view: () => ReactElement, body: (container: HTMLDivElement, rerender: () => void) => void): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  try {
    act(() => root.render(view()));
    body(container, () => act(() => root.render(view())));
  } finally {
    act(() => root.unmount());
    container.remove();
  }
}

const buttons = (container: HTMLElement, text: string) => [...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === text);
const undoneBadges = (container: HTMLElement) => [...container.querySelectorAll('.st-run-badge')].filter((b) => b.textContent === 'undone');
const hasRevertRun = (container: HTMLElement) => [...container.querySelectorAll('button')].some((b) => b.textContent?.includes('Revert run'));

describe('a step undone another way', () => {
  it('shows as undone after Ctrl+Z or the History panel, not as an Undo that would only say so; a redo brings the button back', async () => {
    await threeStepRun();
    const message = () => useAIStore.getState().messages.find((m) => m.run)!;
    const step = (subject: string) => message().run!.entries.find((e): e is Extract<typeof e, { kind: 'tool' }> => e.kind === 'tool' && e.subject === subject && Boolean(e.transactionId))!;
    mount(
      () => <RunTimeline message={message()} />,
      (container, rerender) => {
        expect(buttons(container, 'Undo')).toHaveLength(3);
        // Ctrl+Z undoes the newest unit: the run's last step.
        act(() => useVFSStore.getState().undoLast());
        rerender();
        expect(useVFSStore.getState().readFile('ui/main.ui')).toBe(APP.ui);
        expect(stepUndoState(step('ui/main.ui'))).toEqual({ kind: 'undone' });
        expect(buttons(container, 'Undo')).toHaveLength(2);
        expect(undoneBadges(container)).toHaveLength(1);
        // Derived from the files, not recorded: Ctrl+Y brings the change back, and its Undo with it.
        act(() => useVFSStore.getState().redoLast());
        rerender();
        expect(buttons(container, 'Undo')).toHaveLength(3);
        expect(undoneBadges(container)).toHaveLength(0);

        // The History panel reverts a unit by its transaction.
        expect(useVFSStore.getState().revertTransaction(step('ui/one.ui').transactionId!).ok).toBe(true);
        rerender();
        expect(stepUndoState(step('ui/one.ui'))).toEqual({ kind: 'undone' });
        expect(buttons(container, 'Undo')).toHaveLength(2);
        expect(undoneBadges(container)).toHaveLength(1);
        expect(hasRevertRun(container)).toBe(true);

        // Everything undone by Ctrl+Z: Revert run has nothing left to do and is not offered.
        for (let i = 0; i < 3; i++) act(() => useVFSStore.getState().undoLast());
        rerender();
        expect(useVFSStore.getState().readFile('ui/one.ui')).toBeNull();
        expect(useVFSStore.getState().readFile('ui/main.ui')).toBe(APP.ui);
        expect(useVFSStore.getState().readFile('logic/main.logic')).toBe(APP.logic);
        expect(buttons(container, 'Undo')).toHaveLength(0);
        expect(undoneBadges(container)).toHaveLength(3);
        expect(hasRevertRun(container)).toBe(false);
      },
    );
  });

  it('after a reload too: a step whose file was put back by hand shows as undone, and Revert run reverts the rest', async () => {
    await threeStepRun();
    const { fresh, message, read, entry } = await saveAndReload();
    const main = entry('edit_file', 'ui/main.ui');
    mount(
      () => <fresh.Timeline message={message()} />,
      (container, rerender) => {
        expect(buttons(container, 'Undo')).toHaveLength(3);
        fresh.vfs.getState().updateFile('ui/main.ui', APP.ui, 'user');
        rerender();
        expect(fresh.agent.stepUndoState(main)).toEqual({ kind: 'undone' });
        expect(buttons(container, 'Undo')).toHaveLength(2);
        expect(undoneBadges(container)).toHaveLength(1);
        // Ctrl+Z of that edit puts the step's change back, and its Undo with it.
        act(() => fresh.vfs.getState().undoLast());
        rerender();
        expect(read('ui/main.ui')).toContain('Chores');
        expect(buttons(container, 'Undo')).toHaveLength(3);
        // Put back by hand again, then Revert run: the rest goes, with no complaint about the step already undone.
        fresh.vfs.getState().updateFile('ui/main.ui', APP.ui, 'user');
        rerender();
        const revert = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Revert run'))!;
        act(() => revert.click());
        rerender();
        expect(read('ui/one.ui')).toBeNull();
        expect(read('logic/main.logic')).toBe(APP.logic);
        expect(container.textContent).toContain('This run was reverted.');
      },
    );
  });
});

describe('Revert this turn', () => {
  /** A turn from the single-shot Studio: one assistant message, one transaction of two files. */
  function seedTurn(): void {
    useVFSStore.getState().applyTransaction(
      [
        { op: 'update', path: 'ui/main.ui', content: APP.ui.replace('Tasks', 'Chores') },
        { op: 'create', path: 'ui/one.ui', content: ONE },
      ],
      'ai',
      'turn-1',
    );
    useAIStore.getState().addMessage({ id: 'm-turn', role: 'assistant', content: 'Renamed it and added a page.', timestamp: 1, transactionId: 'turn-1' });
  }

  it('reverts the turn after a reload, from the journal', async () => {
    seedTurn();
    const { fresh, read } = await saveAndReload();
    const turn = () => fresh.ai.getState().messages.find((m) => m.id === 'm-turn')!;
    expect(fresh.agent.turnRevertState(turn())).toEqual({ kind: 'available' });
    mount(
      () => <fresh.Chat />,
      (container, rerender) => {
        const button = buttons(container, 'Revert this turn');
        expect(button).toHaveLength(1);
        act(() => button[0].click());
        rerender();
        expect(read('ui/main.ui')).toBe(APP.ui);
        expect(read('ui/one.ui')).toBeNull();
        expect(container.textContent).toContain('Reverted 2 file(s)');
        expect(buttons(container, 'Revert this turn')).toHaveLength(0);
      },
    );
  });

  it('refuses when a file was edited after the turn, with the same message as a step, and changes nothing', async () => {
    seedTurn();
    useVFSStore.getState().updateFile('ui/main.ui', 'mine', 'user');
    const { fresh, read } = await saveAndReload();
    const refused = fresh.agent.revertChatTurn('m-turn');
    expect(refused.ok ? '' : refused.reason).toBe('ui/main.ui was edited after this turn. Undo that edit first, or revert by hand.');
    expect(read('ui/one.ui')).toBe(ONE);
    expect(read('ui/main.ui')).toBe('mine');
  });

  it('shows the turn as undone when its files were put back another way', () => {
    seedTurn();
    useVFSStore.getState().undoLast();
    expect(turnRevertState(useAIStore.getState().messages.find((m) => m.id === 'm-turn')!)).toEqual({ kind: 'undone' });
  });

  it('is hidden, with the reason, when the journal has no data for it', async () => {
    seedTurn();
    const { fresh, read } = await saveAndReload((record) => {
      delete record.undo;
    });
    const turn = fresh.ai.getState().messages.find((m) => m.id === 'm-turn')!;
    expect(fresh.agent.turnRevertState(turn)).toMatchObject({ kind: 'unavailable', reason: expect.stringMatching(/no undo data was saved for this change/) });
    mount(
      () => <fresh.Chat />,
      (container) => {
        expect(buttons(container, 'Revert this turn')).toHaveLength(0);
        expect(container.textContent).toContain("Can't be undone from here: no undo data was saved for this change");
      },
    );
    expect(fresh.agent.revertChatTurn('m-turn').ok).toBe(false);
    expect(read('ui/one.ui')).toBe(ONE);
  });
});
