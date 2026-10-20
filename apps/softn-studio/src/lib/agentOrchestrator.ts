/**
 * The chat's entry points into the agent, and what the single-shot turn left
 * that is still used.
 *
 * A turn used to be one request: a system prompt carrying every file's
 * contents up to a budget, a reply of <softn-file> blocks, up to three rounds
 * of <softn-read>, and one changeset. It is now an agent run (lib/agent/): the
 * model calls tools — read, search, edit, write, check, test — in a loop until
 * the request is done, and each write is its own undoable step. The prompt's
 * language guide moved to lib/agent/guide.ts, corrected against the parser and
 * the renderer, and is re-exported here where the tests have always found it.
 * (The agent's text protocol reads a stray <softn-file> block itself, in
 * lib/agent/protocol.ts.)
 */

import { useAIStore } from '../stores/aiStore';
import { useVFSStore } from '../stores/vfsStore';
import type { TurnBase } from './changeset';
import { buildAgentSystemPrompt } from './agent/prompt';
import { discardAgentRuns, startAgentRun } from './agent/runAgent';
import { randomUUID } from '@softn/bundle-format/crypto';

// The write checks live with the changeset that uses them; they are still
// reachable from here, where they were first written.
export { checkWrite } from './changeset';
export type { SuppliedFiles, TurnBase } from './changeset';
export { PYTHON_APP_EXAMPLE, PYTHON_TORCH_SECTION, PYTHON_TORCH_UNDECLARED } from './agent/guide';

/**
 * The system prompt an agent run starts with, and the version of every
 * project file at this moment. Nothing is "supplied" up front any more: the
 * agent reads files with read_file, and the run's own record of what it read
 * is what its writes are judged against.
 */
export function buildSystemPromptWithRecord(): { system: string } & TurnBase {
  const versions = new Map<string, number>();
  for (const [path, file] of useVFSStore.getState().files) versions.set(path, file.version);
  return { system: buildAgentSystemPrompt('anthropic'), supplied: new Map(), versions };
}

/** Start an agent run for the chat's latest message. */
export async function runAgentTurn(options: { kind?: 'build' | 'edit' } = {}): Promise<void> {
  await startAgentRun(options);
}

/** Whether a request sent now would be taken: a provider is chosen and no run is working. */
export function canAskAgent(): boolean {
  const ai = useAIStore.getState();
  return ai.agentState === 'idle' && ai.providers.some((provider) => provider.id === ai.activeProviderId);
}

/**
 * Ask the agent to mend what stopped the app in the preview: the reason goes
 * into the chat as the person's request, which is what they would have typed,
 * and a run starts. (What the preview reported is handed to that run with the
 * project, lib/previewFaults.ts; this only saves the typing.) False, with
 * nothing sent, where no request would be taken.
 */
export function askAgentToFix(reason: string): boolean {
  if (!canAskAgent()) return false;
  useAIStore.getState().addMessage({
    id: randomUUID(),
    role: 'user',
    content: `The app stopped in the preview: ${reason} Find what causes it and fix it.`,
    timestamp: Date.now(),
  });
  void runAgentTurn();
  return true;
}

/** Abandon any run: the project is changing under the chat. */
export function abortAgentTurn(): void {
  discardAgentRuns();
}
