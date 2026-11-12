/**
 * Going Home while the AI is working.
 *
 * Home used to end every run without a word: the run a person had been
 * waiting for was discarded, its row left saying "working" over nothing, and
 * when they came back all it offered was to start again from its notes. The
 * project is still the one in memory on the home page, so nothing has to be
 * thrown away. A run that is working is the person's to stop: they are asked,
 * and it is stopped the way the chat's Stop button stops it, so what it wrote
 * stays and Continue picks it up with its whole conversation. A run that is
 * waiting for an answer, or paused, is not working, and is left as it is.
 *
 * Opening the project in the Builder asks the same way (lib/builderFlip.ts).
 * That leaves the page, and a run's conversation does not outlive its page,
 * so what is promised there is less: what it wrote is kept and goes along,
 * and the request is made again on coming back.
 *
 * (Opening another project is another matter: lib/replaceProject.ts discards
 * the run, which would otherwise write into the project that takes this
 * one's place.)
 */

import { stopAgentRun } from './agent/runAgent';
import { useAIStore } from '../stores/aiStore';
import { useWorkspaceStore } from '../stores/workspaceStore';

/** Where the person is going, in the words the question is asked in. */
export interface Leaving {
  /** What stops the run, as the subject of a sentence: "Going to Home". */
  going: string;
  /** What becomes of the run's work. */
  kept: string;
  /** What the person agrees to, after "Stop the AI and". */
  go: string;
}

export const TO_HOME: Leaving = {
  going: 'Going to Home',
  kept: 'What it has written so far is kept, and Continue in the chat picks it up from where it stopped.',
  go: 'go to Home',
};

export const TO_BUILDER: Leaving = {
  going: 'Opening the Builder',
  kept: 'What it has written so far is kept, and goes to the Builder with the rest of the project. To have the AI finish, ask it again when you are back.',
  go: 'open the Builder',
};

/** What the person is asked when they leave while a run works: Home, unless said. */
export function leaveRunQuestion(projectName: string, leaving: Leaving = TO_HOME): string {
  const name = projectName.trim() || 'this app';
  return `The AI is still working on ${name}. ${leaving.going} stops it. ${leaving.kept}\n\nStop the AI and ${leaving.go}?`;
}

/**
 * Whether leaving may go ahead. True when no run is working, or when the
 * person agreed to stop the one that is (it is stopped before this answers);
 * false when they would rather stay, and then nothing has changed.
 */
export function stopRunToLeave(leaving: Leaving = TO_HOME): boolean {
  if (useAIStore.getState().agentState !== 'building') return true;
  if (!window.confirm(leaveRunQuestion(useWorkspaceStore.getState().projectName, leaving))) return false;
  stopAgentRun();
  return true;
}
