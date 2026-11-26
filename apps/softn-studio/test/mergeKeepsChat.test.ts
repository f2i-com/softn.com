/**
 * A save merged with another tab's, when the chat is at the most a record keeps.
 *
 * The merged chat keeps its newest 200 messages, so one the other tab had added can be left
 * out of it. Bringing the merge in, such a message was taken for one the other tab deleted, and
 * taken out of this tab's chat at its place, which it does not have here: removing from place
 * -1 removed this tab's newest message, and the next save took it out of storage too.
 */

import { afterEach, expect, it } from 'vitest';
import type { ProjectRecord, SaveResult } from '../src/lib/persistence';
import { beginNewProjectSession, startProjectAutosave, type AutosaveController } from '../src/lib/projectSession';
import { useAIStore, useVFSStore, useWorkspaceStore } from '../src/stores';
import type { ChatMessage } from '../src/types/studio';

let autosave: AutosaveController | null = null;
afterEach(() => {
  autosave?.stop();
  autosave = null;
});

it('keeps this tab’s newest message when the merged chat leaves out one of the other tab’s', async () => {
  beginNewProjectSession();
  useWorkspaceStore.getState().setProjectName('Notes');
  useVFSStore.getState().createFile('ui/main.ui', '<App />');
  let stored: ProjectRecord | null = null;
  let other: ((saved: ProjectRecord) => ProjectRecord) | null = null;
  const save = async (record: ProjectRecord, _lastSeen?: number, reconcile?: (s: ProjectRecord) => ProjectRecord | SaveResult): Promise<SaveResult> => {
    if (other && stored && reconcile) {
      const answer = reconcile(other(stored));
      if ('ok' in answer) return answer;
      stored = answer;
      return { ok: true };
    }
    stored = record;
    return { ok: true };
  };
  autosave = startProjectAutosave({ save, debounceMs: 1, maxWaitMs: 1 });
  expect((await autosave.flush()).ok).toBe(true);

  // Said here, since that save.
  const mine: ChatMessage = { id: 'mine', role: 'user', content: 'Add a page for notes', timestamp: 2_000_000 };
  useAIStore.getState().addMessage(mine);
  // Meanwhile another tab said 200 things, all of them before it, and saved.
  other = (saved) => ({
    ...saved,
    revision: saved.revision + 7,
    session: { ...saved.session, messages: Array.from({ length: 200 }, (_, i): ChatMessage => ({ id: `theirs-${i}`, role: 'assistant', content: `Line ${i}`, timestamp: 1_000_000 + i })) },
  });
  expect((await autosave.flush()).ok).toBe(true);

  const messages = useAIStore.getState().messages;
  expect(messages.map((m) => m.id)).toContain('mine');
  expect(messages.at(-1)?.id).toBe('mine');
  expect(stored!.session.messages.map((m) => m.id)).toContain('mine');
});
