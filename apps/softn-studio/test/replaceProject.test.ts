/** @vitest-environment jsdom */
/**
 * Answering "stay" keeps the run as well as the draft.
 *
 * Everything that replaces the open project (a new app, an example, an
 * import, a project from the list, and the host opening an app in a hosted
 * Studio) stops the agent first, because a run left working would write its
 * files into the project that takes this one's place. Each of them also asks
 * about a file being edited by hand with changes that are not saved. They
 * asked in the wrong order: the run was discarded, and then the person was
 * asked whether to leave. Answering Cancel kept the draft and the project,
 * and the run they were waiting for was already gone, with nothing to
 * continue. The question comes first now, and nothing is touched until it is
 * answered.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAgentRun } from '../src/lib/agent/runAgent';
import { beginHandEdit } from '../src/lib/handEdit';
import { currentGeneration } from '../src/lib/projectSession';
import { beginReplacingProject } from '../src/lib/replaceProject';
import { useAIStore } from '../src/stores/aiStore';
import { useEditStore } from '../src/stores/editStore';
import { assertScriptsPassed, fakeProvider, lastRun, resetAgent, say, seedApp } from './helpers/agentHarness';

beforeEach(() => {
  resetAgent();
  useEditStore.getState().close();
});
afterEach(() => {
  assertScriptsPassed();
  vi.restoreAllMocks();
  useEditStore.getState().close();
  resetAgent();
});

/** A run held at its first request, and a draft of the main page with a change not saved. */
async function runningWithADraft() {
  seedApp();
  const provider = fakeProvider('anthropic', [{ calls: [{ name: 'finish', input: { summary: 'Done.' } }] }]);
  say('Go');
  const held = provider.hold();
  const running = startAgentRun();
  await new Promise((r) => setTimeout(r, 0));
  expect(lastRun().run.status).toBe('running');
  expect(beginHandEdit('ui/main.ui')).toBeNull();
  useEditStore.getState().change(`${useEditStore.getState().draft!.text}\n<!-- mine -->\n`);
  return { held, running };
}

describe('before the open project is replaced', () => {
  it('a person who answers Cancel keeps their draft and the run they were waiting for', async () => {
    const { held, running } = await runningWithADraft();
    const generation = currentGeneration();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    expect(beginReplacingProject()).toBeNull();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatch(/ui\/main\.ui has changes you have not saved/);
    // Nothing was touched: the run is still working, the draft is still open, and no other
    // open that was in flight has been superseded.
    expect(lastRun().run.status).toBe('running');
    expect(useAIStore.getState().agentState).toBe('building');
    expect(useEditStore.getState().draft?.text).toMatch(/mine/);
    expect(currentGeneration()).toBe(generation);

    held.release();
    await running;
    expect(lastRun().run.status).toBe('finished');
  });

  it('a person who agrees to leave has the draft discarded, the run stopped and the workspace claimed', async () => {
    const { held, running } = await runningWithADraft();
    const generation = currentGeneration();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const claimed = beginReplacingProject();

    expect(claimed).toBe(generation + 1);
    expect(currentGeneration()).toBe(generation + 1);
    expect(useEditStore.getState().draft).toBeNull();
    expect(useAIStore.getState().agentState).toBe('idle');
    held.release();
    await running;
  });

  it('nothing is asked when no draft is open, and a claim made earlier is kept', async () => {
    seedApp();
    const confirm = vi.spyOn(window, 'confirm');
    // The remote open claims the workspace before the bytes arrive, and hands its claim on.
    expect(beginReplacingProject(41)).toBe(41);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('is the first thing each of the editor’s own ways out of a project does', () => {
    // The handlers live in App.tsx, which no test mounts: held here to going through the one
    // function, so that none of them goes back to stopping the run on its own before asking.
    const source = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    expect(source.match(/beginReplacingProject\(/g)?.length).toBe(4);
    // Home leaves the project in memory, and the two unmount cleanups have nobody to ask.
    expect(source.match(/abortAgentTurn\(\)/g)?.length).toBe(3);
  });
});
