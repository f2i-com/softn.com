/**
 * A run does not finish on a check that failed, whichever reply the finish is in.
 *
 * "Finishing does not get past a broken app" was held for one shape only: a
 * reply that wrote and called finish together. The check ran, failed, and the
 * finish was refused. But a model that wrote in one reply, read the failed
 * check in its result, and called finish in the next reply was simply
 * believed: nothing had been written in that reply, so nothing was checked,
 * and the run ended "Finished" over an app the timeline's own last check row
 * called broken. A real run did exactly that with an endless loop it had put
 * into `_init`: "Automatic check, 2 errors", then "Done".
 *
 * The run remembers its last check. A finish that follows a failed one, with
 * nothing written since, is refused with the errors said again; a model that
 * answers by calling finish again ends the run as failed, with the error in
 * the reason, so the person is not told a broken app is done and the model
 * is not kept going round for ever.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAgentSystemPrompt } from '../src/lib/agent/prompt';
import { answerAgentQuestion, continueAgentRun, startAgentRun } from '../src/lib/agent/runAgent';
import { useAIStore } from '../src/stores/aiStore';
import { useVFSStore } from '../src/stores/vfsStore';
import { assertScriptsPassed, fakeProvider, lastRun, resetAgent, resultsIn, say, seedApp, text } from './helpers/agentHarness';

beforeEach(() => {
  resetAgent();
  seedApp();
});
afterEach(() => {
  assertScriptsPassed();
  resetAgent();
});

const BREAK = { name: 'edit_file', input: { path: 'ui/main.ui', old_string: 'main.logic', new_string: 'gone.logic' } };
const MEND = { name: 'edit_file', input: { path: 'ui/main.ui', old_string: 'gone.logic', new_string: 'main.logic' } };
const READ = { name: 'read_file', input: { path: 'ui/main.ui' } };
const finish = (summary: string) => ({ name: 'finish', input: { summary } });
const toolEntries = () => lastRun().run.entries.filter((e) => e.kind === 'tool') as Array<Extract<ReturnType<typeof lastRun>['run']['entries'][number], { kind: 'tool' }>>;

describe('finish after a check that failed', () => {
  it('is refused in the reply after the write, with the errors said again, and accepted once they are fixed', async () => {
    const provider = fakeProvider('anthropic', [
      { calls: [READ, BREAK] },
      (body) => {
        expect(resultsIn(body)).toContain('[Automatic check] Check found 1 error(s)');
        return { text: 'That will do.', calls: [finish('Renamed the logic file.')] };
      },
      (body) => {
        const sent = resultsIn(body);
        expect(sent).toContain('Not accepted: the last check of the app found errors and nothing has changed since');
        expect(sent).toContain('logic/gone.logic is referenced by ui/main.ui but is not in the bundle');
        return { calls: [MEND, finish('Put the logic file back.')] };
      },
    ]);
    say('Rename the logic file');
    await startAgentRun();
    const { run } = lastRun();
    expect(provider.count()).toBe(3);
    expect(run.status).toBe('finished');
    expect(run.summary).toBe('Put the logic file back.');
    expect(text('ui/main.ui')).toContain('main.logic');
    // The refused finish is a row that says so, not a "Done".
    const refused = toolEntries().filter((e) => e.name === 'finish');
    expect(refused.map((e) => e.status)).toEqual(['error', 'ok']);
    expect(refused[0].result).toMatch(/^Not accepted: the last check/);
  });

  it('ends the run as failed, with the error in the reason, when the model only says finish again', async () => {
    const provider = fakeProvider('anthropic', [
      { calls: [READ, BREAK] },
      { calls: [finish('Renamed the logic file.')] },
      { calls: [finish('It is renamed.')] },
    ]);
    say('Rename the logic file');
    await startAgentRun();
    const { run } = lastRun();
    expect(provider.count()).toBe(3);
    expect(run.status).toBe('failed');
    expect(run.summary).toBeUndefined();
    expect(run.reason).toMatch(/^The agent said it was finished while the check still finds 1 error: .*logic\/gone\.logic is referenced by ui\/main\.ui/);
    expect(run.reason).toMatch(/Continue to let it try again, or say how to fix it\.$/);
    expect(useAIStore.getState().agentState).toBe('idle');
  });

  it('is refused when the model ran the check itself and it failed, in the same reply or the one before', async () => {
    const provider = fakeProvider('anthropic', [
      { calls: [READ, BREAK, { name: 'check_app', input: {} }] },
      { calls: [{ name: 'check_app', input: {} }, finish('Checked and done.')] },
      (body) => {
        expect(resultsIn(body)).toContain('Not accepted: the last check of the app found errors');
        return { calls: [MEND] };
      },
      (body) => {
        expect(resultsIn(body)).toContain('[Automatic check] Check passed');
        return { calls: [finish('Fixed.')] };
      },
    ]);
    say('Rename the logic file');
    await startAgentRun();
    expect(provider.count()).toBe(4);
    expect(lastRun().run.status).toBe('finished');
    expect(lastRun().run.summary).toBe('Fixed.');
  });

  it('is accepted after a check that passed, and after a write that no check has judged', async () => {
    // A passing check clears an earlier failure.
    fakeProvider('anthropic', [
      { calls: [READ, BREAK] },
      { calls: [MEND] },
      { calls: [finish('Back as it was.')] },
    ]);
    say('Try a rename');
    await startAgentRun();
    expect(lastRun().run.status).toBe('finished');

    // With the automatic check turned off, a write since the failed check may have mended it:
    // nothing has judged the app since, so the finish is the person's setting to live with.
    resetAgent();
    seedApp();
    useAIStore.getState().updateAgentSettings({ autoCheck: false });
    fakeProvider('anthropic', [
      { calls: [READ, BREAK, { name: 'check_app', input: {} }] },
      { calls: [MEND, finish('Mended without a check.')] },
    ]);
    say('Try a rename');
    await startAgentRun();
    expect(lastRun().run.status).toBe('finished');
    expect(lastRun().run.summary).toBe('Mended without a check.');
  });

  // The refusal tells the model to ask the person about an error it cannot fix. What the
  // person answers is theirs to decide: a finish after their answer is taken.
  it('is accepted once the person has been asked and has answered', async () => {
    const provider = fakeProvider('anthropic', [
      { calls: [READ, BREAK] },
      { calls: [finish('Renamed.')] },
      (body) => {
        expect(resultsIn(body)).toContain('ask the person (ask_user)');
        return { calls: [{ name: 'ask_user', input: { question: 'The logic file is missing. Leave it for now?' } }] };
      },
      (body) => {
        expect(resultsIn(body)).toContain('The person answered: Yes, leave it');
        return { calls: [finish('Renamed; the logic file is still to be written, as you said.')] };
      },
    ]);
    say('Rename the logic file');
    await startAgentRun();
    expect(lastRun().run.status).toBe('waiting');
    await answerAgentQuestion(lastRun().run.id, 'Yes, leave it');
    expect(provider.count()).toBe(4);
    expect(lastRun().run.status).toBe('finished');
    expect(lastRun().run.summary).toMatch(/still to be written/);
  });

  // "Summarize how this app is put together" is one of the chat's own suggestions. A run that
  // only reads has broken nothing: a project that came in broken does not hold it open.
  it('is accepted in a run that changed nothing, whatever a check it ran says of the project', async () => {
    useVFSStore.getState().updateFile('ui/main.ui', text('ui/main.ui').replace('main.logic', 'gone.logic'), 'user');
    const provider = fakeProvider('anthropic', [
      { calls: [READ, { name: 'check_app', input: {} }] },
      (body) => {
        expect(resultsIn(body)).toContain('logic/gone.logic is referenced by ui/main.ui');
        return { calls: [finish('It is one page; its logic file is missing.')] };
      },
    ]);
    say('Summarize how this app is put together');
    await startAgentRun();
    expect(provider.count()).toBe(2);
    expect(lastRun().run.status).toBe('finished');
  });

  it('tells the model the rule where it is told how to finish', () => {
    const prompt = buildAgentSystemPrompt('anthropic');
    expect(prompt).toMatch(/finish is not accepted while the last check of your changes has errors/);
    expect(prompt).toMatch(/ask the person \(ask_user\)/);
  });

  it('lets the person continue a run that ended that way, and the model mend it', async () => {
    const provider = fakeProvider('anthropic', [
      { calls: [READ, BREAK] },
      { calls: [finish('Renamed.')] },
      { calls: [finish('Renamed.')] },
      { calls: [MEND, finish('Mended after all.')] },
    ]);
    say('Rename the logic file');
    await startAgentRun();
    expect(lastRun().run.status).toBe('failed');
    await continueAgentRun(lastRun().run.id);
    expect(provider.count()).toBe(4);
    expect(lastRun().run.status).toBe('finished');
    expect(lastRun().run.summary).toBe('Mended after all.');
  });
});
