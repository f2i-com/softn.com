/**
 * The agent loop, driven end to end by scripted providers in each protocol:
 * Anthropic tool_use, OpenAI-compatible tool_calls, and the text fallback.
 * The VFS, the changeset rules, the validator and the composer are real; only
 * the provider (fetch) is scripted, and the headless render is absent (node).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFromBrief, canBuildFromBrief } from '../src/lib/agent/buildFromBrief';
import {
  answerAgentQuestion,
  continueAgentRun,
  revertAgentRun,
  startAgentRun,
  stopAgentRun,
  undoAgentStep,
} from '../src/lib/agent/runAgent';
import { parseTextToolCalls } from '../src/lib/agent/protocol';
import { useAIStore } from '../src/stores/aiStore';
import { useVFSStore } from '../src/stores/vfsStore';
import { useWorkspaceStore } from '../src/stores/workspaceStore';
import { APP, assertScriptsPassed, fakeProvider, lastRun, LOCAL, OPENAI, resetAgent, resultsIn, say, seedApp, text } from './helpers/agentHarness';

beforeEach(() => resetAgent());
afterEach(() => {
  assertScriptsPassed();
  resetAgent();
});

const toolEntries = () => lastRun().run.entries.filter((e) => e.kind === 'tool') as Array<Extract<ReturnType<typeof lastRun>['run']['entries'][number], { kind: 'tool' }>>;

describe('building a new app (Anthropic tool_use)', () => {
  it('plans, writes, is checked after each write, and finishes — every result paired with its tool_use in one message', async () => {
    useWorkspaceStore.getState().setBrief({
      appName: 'Tasks', description: 'A task list', target: 'web', pages: ['Home'], collections: [], authNeeded: false, style: 'clean', referenceImages: [],
    });
    const provider = fakeProvider('anthropic', [
      {
        text: 'I will build the task list.',
        calls: [{ name: 'update_plan', input: { items: [{ text: 'Write the page', status: 'active' }, { text: 'Write the logic', status: 'pending' }] } }],
      },
      { calls: [{ name: 'write_file', input: { path: 'manifest.json', content: APP.manifest } }, { name: 'write_file', input: { path: 'ui/main.ui', content: APP.ui } }] },
      (body) => {
        // The automatic check ran after the writes and found the missing logic file.
        expect(resultsIn(body)).toMatch(/\[Automatic check\] Check found .*logic\/main\.logic is referenced by ui\/main\.ui but is not in the bundle/);
        return { calls: [{ name: 'write_file', input: { path: 'logic/main.logic', content: APP.logic } }] };
      },
      (body) => {
        expect(resultsIn(body)).toMatch(/\[Automatic check\] Check passed/);
        return { calls: [{ name: 'update_plan', input: { items: [{ text: 'Write the page', status: 'done' }, { text: 'Write the logic', status: 'done' }] } }, { name: 'finish', input: { summary: 'Built a task list with a counter.' } }] };
      },
    ]);
    say('Build the app');
    await startAgentRun({ kind: 'build' });

    const { run, message } = lastRun();
    expect(run.status).toBe('finished');
    expect(run.summary).toBe('Built a task list with a counter.');
    expect(message.content).toBe('Built a task list with a counter.');
    expect(run.plan.map((p) => p.status)).toEqual(['done', 'done']);
    expect(text('ui/main.ui')).toBe(APP.ui);
    expect(text('logic/main.logic')).toBe(APP.logic);
    expect(run.transactions).toHaveLength(3);
    expect(run.steps).toBe(6);
    expect(run.tokens).toEqual({ input: 400, output: 80, effective: 480 });

    // The wire: tools offered; each assistant turn echoed whole; all results in one user message.
    const second = provider.bodies[1];
    expect(Array.isArray(second.tools)).toBe(true);
    const messages = provider.bodies[2].messages as Array<{ role: string; content: unknown }>;
    const toolUses = (messages.filter((m) => m.role === 'assistant').flatMap((m) => m.content as Array<{ type: string; id?: string }>)).filter((b) => b.type === 'tool_use');
    const results = messages.filter((m) => m.role === 'user' && Array.isArray(m.content)).flatMap((m) => m.content as Array<{ type: string; tool_use_id?: string }>).filter((b) => b.type === 'tool_result');
    expect(results.map((r) => r.tool_use_id)).toEqual(toolUses.map((u) => u.id));
    const writeTurn = messages[4].content as Array<{ type: string }>;
    expect(writeTurn.map((b) => b.type)).toEqual(['tool_result', 'tool_result']);

    // The timeline: the plan, a diff per write, the automatic checks.
    const writes = toolEntries().filter((e) => e.name === 'write_file');
    expect(writes.every((e) => e.diff?.[0].added)).toBe(true);
    const checks = toolEntries().filter((e) => e.auto);
    expect(checks.map((c) => c.check?.ok)).toEqual([false, true]);
    expect(useWorkspaceStore.getState().isDirty).toBe(true);
  });

  it('is what approving a blueprint starts: a build request in the chat and a build run', async () => {
    expect(canBuildFromBrief()).toBe(false);
    useWorkspaceStore.getState().setBrief({
      appName: 'Habits', description: 'Track daily habits', target: 'web', pages: ['Today', 'Stats'], collections: ['habits'], authNeeded: false, style: 'clean', referenceImages: [],
    });
    useAIStore.setState({ modelProfile: { architect: 'planner-model', builder: '', repair: '', vision: '' } });
    const provider = fakeProvider('anthropic', [{ calls: [{ name: 'finish', input: { summary: 'Built.' } }] }]);
    expect(canBuildFromBrief()).toBe(true);
    expect(buildFromBrief()).toBe(true);
    await vi.waitFor(() => expect(lastRun().run.status).toBe('finished'));
    const request = useAIStore.getState().messages.find((m) => m.role === 'user')!;
    expect(request.content).toBe('Build Habits as the brief describes: Track daily habits Pages: Today, Stats. Data: habits.');
    expect(provider.bodies[0].model).toBe('planner-model');
    expect(JSON.stringify(provider.bodies[0].messages)).toContain('The project was just scaffolded from the brief');
    expect(JSON.stringify(provider.bodies[0].system)).not.toContain('scaffolded');
    expect(useWorkspaceStore.getState().leftPanel).toBe('ai');
  });

  it('uses the architect model for the first request of a new app and the builder model after', async () => {
    useAIStore.setState({ modelProfile: { architect: 'planner-model', builder: '', repair: '', vision: '' } });
    const provider = fakeProvider('anthropic', [{ calls: [{ name: 'list_files', input: {} }] }, { calls: [{ name: 'finish', input: { summary: 'ok' } }] }]);
    say('Build');
    await startAgentRun({ kind: 'build' });
    expect(provider.bodies.map((b) => b.model)).toEqual(['planner-model', 'model-under-test']);
  });
});

describe('editing with edit_file (OpenAI tool_calls)', () => {
  beforeEach(() => {
    resetAgent(OPENAI);
    seedApp();
  });

  it('refuses an edit before a read, a non-unique match and a mismatch, with the reasons; then applies the exact one', async () => {
    const provider = fakeProvider('openai', [
      { calls: [{ name: 'edit_file', input: { path: 'ui/main.ui', old_string: 'Tasks', new_string: 'Chores' } }] },
      (body) => {
        expect(resultsIn(body)).toContain('you have not read it in this run');
        return { calls: [{ name: 'read_file', input: { path: 'ui/main.ui' } }] };
      },
      { calls: [{ name: 'edit_file', input: { path: 'ui/main.ui', old_string: 'Stack', new_string: 'Box' } }] },
      (body) => {
        // Two places match (<Stack and </Stack>): refused, naming the lines.
        expect(resultsIn(body)).toMatch(/matches 2 places in ui\/main\.ui \(lines 4, 8\)/);
        return { calls: [{ name: 'edit_file', input: { path: 'ui/main.ui', old_string: '<Heading level={2}>Tasks</Heading>', new_string: 'x' } }] };
      },
      (body) => {
        const sent = resultsIn(body);
        expect(sent).toContain('old_string was not found in ui/main.ui');
        expect(sent).toContain('The closest lines are');
        expect(sent).toContain('<Heading level={1}>Tasks</Heading>');
        return { calls: [{ name: 'edit_file', input: { path: 'ui/main.ui', old_string: '<Heading level={1}>Tasks</Heading>', new_string: '<Heading level={1}>Chores</Heading>' } }] };
      },
      { calls: [{ name: 'finish', input: { summary: 'Renamed the heading.' } }] },
    ]);
    say('Rename the heading to Chores');
    await startAgentRun();

    expect(lastRun().run.status).toBe('finished');
    expect(text('ui/main.ui')).toContain('<Heading level={1}>Chores</Heading>');
    expect(text('ui/main.ui').replace('Chores', 'Tasks')).toBe(APP.ui);
    // OpenAI wire: functions, and each result as a role "tool" message with its call id.
    const body = provider.bodies[5];
    expect((body.tools as Array<{ type: string }>)[0].type).toBe('function');
    const messages = body.messages as Array<{ role: string; tool_call_id?: string; tool_calls?: Array<{ id: string }> }>;
    const ids = messages.filter((m) => m.role === 'assistant').flatMap((m) => m.tool_calls ?? []).map((c) => c.id);
    expect(messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(ids);
    expect(messages[0].role).toBe('system');
    const edits = toolEntries().filter((e) => e.name === 'edit_file');
    expect(edits.map((e) => e.status)).toEqual(['error', 'error', 'error', 'ok']);
  });

  it('refuses a non-unique old_string and names the lines, and replace_all changes them all', async () => {
    useVFSStore.getState().hydrateFiles([{ path: 'ui/list.ui', content: '<Text>a</Text>\n<Text>a</Text>' }]);
    fakeProvider('openai', [
      { calls: [{ name: 'read_file', input: { path: 'ui/list.ui' } }, { name: 'edit_file', input: { path: 'ui/list.ui', old_string: '<Text>a</Text>', new_string: '<Text>b</Text>' } }] },
      (body) => {
        expect(resultsIn(body)).toContain('matches 2 places in ui/list.ui (lines 1, 2)');
        return { calls: [{ name: 'edit_file', input: { path: 'ui/list.ui', old_string: '<Text>a</Text>', new_string: '<Text>b</Text>', replace_all: true } }] };
      },
      { calls: [{ name: 'finish', input: { summary: 'done' } }] },
    ]);
    say('Change both');
    await startAgentRun();
    expect(text('ui/list.ui')).toBe('<Text>b</Text>\n<Text>b</Text>');
  });
});

describe('the changeset rules, as tool errors', () => {
  beforeEach(() => seedApp());

  it('refuses private state, escapes, binaries, bad Python module names, and replacing an unread file — writing nothing', async () => {
    const before = new Map(useVFSStore.getState().files);
    fakeProvider('anthropic', [
      {
        calls: [
          { name: 'write_file', input: { path: 'builder/blueprint.json', content: '{}' } },
          { name: 'write_file', input: { path: '../escape.ui', content: '<App/>' } },
          { name: 'write_file', input: { path: 'assets/logo.png', content: 'not bytes' } },
          { name: 'write_file', input: { path: 'logic/my-app.py', content: 'x = 1' } },
          { name: 'write_file', input: { path: 'ui/main.ui', content: '<App/>' } },
          { name: 'write_file', input: { path: 'UI/Main.ui', content: '<App/>' } },
        ],
      },
      (body) => {
        const sent = resultsIn(body);
        expect(sent).toContain('private editor state');
        expect(sent).toContain('is not a project path');
        expect(sent).toContain('is a binary format');
        expect(sent).toContain('cannot be a Python module');
        expect(sent).toContain('ui/main.ui exists and you have not read it in this run');
        expect(sent).toContain('same file as the project');
        return { calls: [{ name: 'finish', input: { summary: 'Could not.' } }] };
      },
    ]);
    say('Break things');
    await startAgentRun();
    expect(useVFSStore.getState().files).toEqual(before);
    expect(useVFSStore.getState().history).toEqual([]);
    expect(toolEntries().filter((e) => e.name === 'write_file').every((e) => e.status === 'error')).toBe(true);
  });

  it('refuses write_file after reading only part of a file, and an edit to a file the person changed since it was read', async () => {
    const provider = fakeProvider('anthropic', [
      { calls: [{ name: 'read_file', input: { path: 'ui/main.ui', start_line: 1, end_line: 2 } }, { name: 'write_file', input: { path: 'ui/main.ui', content: '<App/>' } }] },
      (body) => {
        expect(resultsIn(body)).toContain('You have read only part of ui/main.ui');
        // The person edits the file while the model is thinking.
        useVFSStore.getState().updateFile('ui/main.ui', APP.ui.replace('Tasks', 'Mine'), 'user');
        return { calls: [{ name: 'edit_file', input: { path: 'ui/main.ui', old_string: 'gap="md"', new_string: 'gap="lg"' } }] };
      },
      (body) => {
        expect(resultsIn(body)).toMatch(/ui\/main\.ui changed since you read it \(v\d+ → v\d+\)/);
        return { calls: [{ name: 'finish', input: { summary: 'Stopped.' } }] };
      },
    ]);
    say('Change it');
    await startAgentRun();
    expect(text('ui/main.ui')).toContain('Mine');
    expect(text('ui/main.ui')).toContain('gap="md"');
    expect(provider.count()).toBe(3);
  });
});

describe('the automatic check and repair', () => {
  beforeEach(() => seedApp());

  it('shows the model the break its edit caused, uses the repair model after two identical failures, and stops after three', async () => {
    useAIStore.setState({ modelProfile: { architect: '', builder: '', repair: 'repair-model', vision: '' } });
    // Three different attempts that leave the same error.
    const broken = (n: number) => ({ name: 'write_file', input: { path: 'ui/main.ui', content: `<logic src="../logic/gone.logic" />
<App><Text>attempt ${n}</Text></App>` } });
    const provider = fakeProvider('anthropic', [
      { calls: [{ name: 'read_file', input: { path: 'ui/main.ui' } }, broken(1)] },
      { calls: [broken(2)] },
      { calls: [broken(3)] },
    ]);
    say('Change it');
    await startAgentRun();
    const { run } = lastRun();
    expect(run.status).toBe('failed');
    expect(run.reason).toMatch(/The same check error came back 3 times/);
    expect(run.reason).toContain('logic/gone.logic is referenced by ui/main.ui but is not in the bundle');
    expect(provider.bodies.map((b) => b.model)).toEqual(['model-under-test', 'model-under-test', 'repair-model']);
  });

  it('does not check again when the model checked after its own write, and skips the check when nothing changed', async () => {
    fakeProvider('anthropic', [
      { calls: [{ name: 'read_file', input: { path: 'logic/main.logic' } }, { name: 'edit_file', input: { path: 'logic/main.logic', old_string: 'let count = 0', new_string: 'let count = 1' } }, { name: 'check_app', input: {} }] },
      { calls: [{ name: 'list_files', input: {} }] },
      { calls: [{ name: 'finish', input: { summary: 'ok' } }] },
    ]);
    say('Start at one');
    await startAgentRun();
    expect(toolEntries().filter((e) => e.auto)).toHaveLength(0);
    expect(toolEntries().filter((e) => e.name === 'check_app').map((e) => e.check?.ok)).toEqual([true]);
  });

  it('does not let a reply that writes and finishes at once finish on a broken app', async () => {
    const provider = fakeProvider('anthropic', [
      { calls: [{ name: 'write_file', input: { path: 'ui/broken.ui', content: '<App><Text>x</Text></App>' } }, { name: 'read_file', input: { path: 'ui/main.ui' } }, { name: 'edit_file', input: { path: 'ui/main.ui', old_string: 'main.logic', new_string: 'gone.logic' } }, { name: 'finish', input: { summary: 'Done, supposedly.' } }] },
      (body) => {
        const sent = resultsIn(body);
        expect(sent).toContain('finish was not accepted');
        expect(sent).toContain('Not accepted: the automatic check found errors');
        return { calls: [{ name: 'edit_file', input: { path: 'ui/main.ui', old_string: 'gone.logic', new_string: 'main.logic' } }, { name: 'finish', input: { summary: 'Fixed and done.' } }] };
      },
    ]);
    say('Change it');
    await startAgentRun();
    const { run } = lastRun();
    expect(run.status).toBe('finished');
    expect(run.summary).toBe('Fixed and done.');
    expect(provider.count()).toBe(2);
    expect(toolEntries().filter((e) => e.auto).map((e) => e.check?.ok)).toEqual([false, true]);
  });

  it('does not let a run finish while the markup uses names the logic never defined', async () => {
    const hollow = `<logic src="../logic/main.logic" />\n\n<App>\n  <Text>{pages.length} pages</Text>\n  #each (bar in probeBars)\n    <Text>{bar.label}</Text>\n  #end\n  <Button @click={() => saveWeek(weekData)}>Save</Button>\n</App>`;
    const provider = fakeProvider('anthropic', [
      { calls: [{ name: 'read_file', input: { path: 'ui/main.ui' } }, { name: 'write_file', input: { path: 'ui/main.ui', content: hollow } }, { name: 'finish', input: { summary: 'Built the week view.' } }] },
      (body) => {
        const sent = resultsIn(body);
        expect(sent).toContain('Not accepted: the automatic check found errors');
        expect(sent).toContain('ui/main.ui line 4: pages is read here but nothing defines it');
        expect(sent).toContain('ui/main.ui line 5: probeBars is read here');
        expect(sent).toContain('ui/main.ui line 8: @click calls saveWeek(), which the logic does not define');
        expect(sent).toContain('ui/main.ui line 8: weekData is read here');
        return {
          calls: [
            { name: 'read_file', input: { path: 'logic/main.logic' } },
            { name: 'write_file', input: { path: 'logic/main.logic', content: `${APP.logic}\n\nlet pages = []\nlet probeBars = []\nlet weekData = {}\n\nfunction saveWeek(week) {\n  count = count + 1\n}` } },
          ],
        };
      },
      (body) => {
        expect(resultsIn(body)).toContain('[Automatic check] Check passed');
        return { calls: [{ name: 'finish', input: { summary: 'Built the week view.' } }] };
      },
    ]);
    say('Add a week view');
    await startAgentRun();
    const { run } = lastRun();
    expect(run.status).toBe('finished');
    expect(provider.count()).toBe(3);
    expect(toolEntries().filter((e) => e.auto).map((e) => e.check?.ok)).toEqual([false, true]);
  });

  it('can be turned off in Settings', async () => {
    useAIStore.getState().updateAgentSettings({ autoCheck: false });
    fakeProvider('anthropic', [
      { calls: [{ name: 'write_file', input: { path: 'ui/extra.ui', content: '<App><Text>x</Text></App>' } }] },
      { calls: [{ name: 'finish', input: { summary: 'ok' } }] },
    ]);
    say('Add a page');
    await startAgentRun();
    expect(toolEntries().filter((e) => e.auto)).toHaveLength(0);
  });
});

describe('pausing for the person', () => {
  beforeEach(() => seedApp());

  it('waits on ask_user and resumes with the answer as the tool result', async () => {
    const provider = fakeProvider('anthropic', [
      { text: 'One question first.', calls: [{ name: 'ask_user', input: { question: 'Which colour should the buttons be?' } }] },
      (body) => {
        expect(resultsIn(body)).toContain('The person answered: Blue');
        return { calls: [{ name: 'finish', input: { summary: 'Made them blue.' } }] };
      },
    ]);
    say('Restyle');
    await startAgentRun();
    let { run } = lastRun();
    expect(run.status).toBe('waiting');
    expect(run.question?.question).toBe('Which colour should the buttons be?');
    expect(useAIStore.getState().agentState).toBe('idle');
    expect(provider.count()).toBe(1);

    await answerAgentQuestion(run.id, 'Blue');
    ({ run } = lastRun());
    expect(run.status).toBe('finished');
    expect(run.question).toBeUndefined();
    expect(toolEntries().find((e) => e.name === 'ask_user')?.result).toBe('You answered: Blue');
  });

  it('asks before deleting more than three files, and honours a decline and an allow', async () => {
    useVFSStore.getState().hydrateFiles([...['a', 'b', 'c', 'd', 'e'].map((n) => ({ path: `ui/${n}.ui`, content: '<App/>' }))]);
    fakeProvider('anthropic', [
      { calls: ['a', 'b', 'c', 'd', 'e'].map((n) => ({ name: 'delete_file', input: { path: `ui/${n}.ui` } })) },
      (body) => {
        const sent = resultsIn(body);
        expect(sent).toContain('The person declined this deletion');
        return { calls: [{ name: 'finish', input: { summary: 'Deleted some.' } }] };
      },
    ]);
    say('Clean up');
    await startAgentRun();
    let { run } = lastRun();
    expect(run.status).toBe('waiting');
    expect(run.question?.confirm?.paths).toEqual(['ui/d.ui']);
    expect(useVFSStore.getState().files.has('ui/c.ui')).toBe(false);
    expect(useVFSStore.getState().files.has('ui/d.ui')).toBe(true);

    await answerAgentQuestion(run.id, false);
    ({ run } = lastRun());
    // The next delete asks again; allow it.
    expect(run.status).toBe('waiting');
    expect(run.question?.confirm?.paths).toEqual(['ui/e.ui']);
    await answerAgentQuestion(run.id, true);
    ({ run } = lastRun());
    expect(run.status).toBe('finished');
    expect(useVFSStore.getState().files.has('ui/d.ui')).toBe(true);
    expect(useVFSStore.getState().files.has('ui/e.ui')).toBe(false);
  });
});

describe('stopping and limits', () => {
  beforeEach(() => seedApp());

  it('stops mid-request, lets no late reply land, and continues where it stopped', async () => {
    const provider = fakeProvider('anthropic', [
      { calls: [{ name: 'read_file', input: { path: 'logic/main.logic' } }] },
      { calls: [{ name: 'write_file', input: { path: 'ui/late.ui', content: '<App/>' } }] },
      (body) => {
        expect(resultsIn(body)).toContain('The person resumed the run');
        return { calls: [{ name: 'finish', input: { summary: 'Resumed and done.' } }] };
      },
    ]);
    say('Go');
    const first = provider.hold();
    const running = startAgentRun();
    await new Promise((r) => setTimeout(r, 0));
    expect(lastRun().run.status).toBe('running');
    stopAgentRun();
    first.release();
    await running;
    let { run } = lastRun();
    expect(run.status).toBe('stopped');
    expect(useAIStore.getState().agentState).toBe('idle');
    // The request that was stopped is asked again on Continue.
    await continueAgentRun(run.id);
    ({ run } = lastRun());
    expect(run.status).toBe('finished');
    expect(useVFSStore.getState().files.has('ui/late.ui')).toBe(true);
  });

  it('leaves a finished run finished when the next run starts, and closes one still waiting', async () => {
    fakeProvider('anthropic', [
      { calls: [{ name: 'finish', input: { summary: 'First.' } }] },
      { calls: [{ name: 'ask_user', input: { question: 'Which?' } }] },
      { calls: [{ name: 'finish', input: { summary: 'Third.' } }] },
    ]);
    say('One');
    await startAgentRun();
    const first = lastRun().message.id;
    say('Two');
    await startAgentRun();
    const second = lastRun().message.id;
    expect(lastRun().run.status).toBe('waiting');
    say('Three');
    await startAgentRun();
    const status = (id: string) => useAIStore.getState().messages.find((m) => m.id === id)?.run?.status;
    expect(status(first)).toBe('finished');
    expect(status(second)).toBe('stopped');
    expect(lastRun().run.status).toBe('finished');
  });

  it('stops at the step cap and Continue grants another allowance', async () => {
    useAIStore.getState().updateAgentSettings({ maxSteps: 5 });
    const list = { calls: [{ name: 'list_files', input: {} }, { name: 'list_files', input: {} }] };
    fakeProvider('anthropic', [list, list, list, list, { calls: [{ name: 'finish', input: { summary: 'ok' } }] }]);
    say('Loop');
    await startAgentRun();
    let { run } = lastRun();
    expect(run.status).toBe('failed');
    expect(run.steps).toBe(5);
    expect(run.reason).toMatch(/limit of 5 steps/);
    await continueAgentRun(run.id);
    ({ run } = lastRun());
    expect(run.maxSteps).toBe(10);
    expect(run.status).toBe('finished');
  });

  it('refuses a request the run budget cannot cover, before sending it', async () => {
    useAIStore.getState().updateAgentSettings({ runTokenBudget: 10_000 });
    const provider = fakeProvider('anthropic', [{ calls: [{ name: 'finish', input: { summary: 'x' } }] }]);
    say('Go');
    await startAgentRun();
    const { run } = lastRun();
    expect(run.status).toBe('failed');
    expect(run.reason).toMatch(/run's token budget would be exceeded/);
    expect(provider.count()).toBe(0);
  });

  it('refuses a request the session budget cannot cover', async () => {
    useAIStore.setState({ tokenBudget: 5_000, tokensUsed: 0 });
    const provider = fakeProvider('anthropic', []);
    say('Go');
    await startAgentRun();
    expect(lastRun().run.reason).toMatch(/session's token budget/);
    expect(useAIStore.getState().lastFailure?.kind).toBe('budget');
    expect(provider.count()).toBe(0);
  });

  it('never applies a reply cut off at the output limit, and asks for smaller steps', async () => {
    fakeProvider('anthropic', [
      { calls: [{ name: 'write_file', input: { path: 'ui/cut.ui', content: '<App>' } }], stop: 'max_tokens' },
      (body) => {
        expect(resultsIn(body)).toContain('cut off at the output limit');
        return { calls: [{ name: 'finish', input: { summary: 'ok' } }] };
      },
    ]);
    say('Go');
    await startAgentRun();
    expect(useVFSStore.getState().files.has('ui/cut.ui')).toBe(false);
    expect(lastRun().run.status).toBe('finished');
  });

  it('pauses on a network failure and resumes the same request', async () => {
    const provider = fakeProvider('anthropic', [{ networkError: true }, { calls: [{ name: 'finish', input: { summary: 'Back.' } }] }]);
    say('Go');
    await startAgentRun();
    let { run } = lastRun();
    expect(run.status).toBe('paused');
    expect(run.reason).toMatch(/Resume sends the request again/);
    await continueAgentRun(run.id);
    ({ run } = lastRun());
    expect(run.status).toBe('finished');
    expect(provider.bodies[1].messages).toEqual(provider.bodies[0].messages);
  });

  it('retries a rate limit after the wait the provider asked for', async () => {
    const provider = fakeProvider('anthropic', [
      { error: { status: 429, body: { error: { message: 'slow down' } }, headers: { 'retry-after': '2' } } },
      { calls: [{ name: 'finish', input: { summary: 'ok' } }] },
    ]);
    say('Go');
    await startAgentRun();
    expect(lastRun().run.status).toBe('finished');
    expect(provider.count()).toBe(2);
  });

  it('stops after the same tool call fails three times in a row', async () => {
    const bad = { calls: [{ name: 'read_file', input: { path: 'ui/nope.ui' } }] };
    fakeProvider('anthropic', [bad, bad, bad]);
    say('Go');
    await startAgentRun();
    const { run } = lastRun();
    expect(run.status).toBe('failed');
    expect(run.reason).toMatch(/failed 3 times in a row/);
  });
});

describe('undo and revert', () => {
  beforeEach(() => seedApp());

  async function twoStepRun() {
    fakeProvider('anthropic', [
      { calls: [{ name: 'write_file', input: { path: 'ui/one.ui', content: '<App><Text>1</Text></App>' } }] },
      { calls: [{ name: 'read_file', input: { path: 'logic/main.logic' } }, { name: 'edit_file', input: { path: 'logic/main.logic', old_string: 'count = 0', new_string: 'count = 5' } }] },
      { calls: [{ name: 'finish', input: { summary: 'Two changes.' } }] },
    ]);
    say('Two changes');
    await startAgentRun();
  }

  it('undoes one step on its own', async () => {
    await twoStepRun();
    const { run, message } = lastRun();
    const edit = toolEntries().find((e) => e.name === 'edit_file')!;
    expect(undoAgentStep(run.id, message.id, edit.id).ok).toBe(true);
    expect(text('logic/main.logic')).toBe(APP.logic);
    expect(useVFSStore.getState().files.has('ui/one.ui')).toBe(true);
    expect(toolEntries().find((e) => e.name === 'edit_file')?.undone).toBe(true);
  });

  it('reverts the whole run in one click, and refuses when a later edit touched its files', async () => {
    await twoStepRun();
    const { message } = lastRun();
    useVFSStore.getState().updateFile('logic/main.logic', 'let count = 9', 'user');
    const refused = revertAgentRun(message.id);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : refused.reason).toContain('logic/main.logic was edited after this run');
    expect(useVFSStore.getState().files.has('ui/one.ui')).toBe(true);
    useVFSStore.getState().undoLast();
    const reverted = revertAgentRun(message.id);
    expect(reverted.ok).toBe(true);
    expect(useVFSStore.getState().files.has('ui/one.ui')).toBe(false);
    expect(text('logic/main.logic')).toBe(APP.logic);
    expect(lastRun().run.reverted).toBe(true);
  });
});

describe('protocol fallback', () => {
  it('moves to the text protocol when the provider rejects `tools`, and remembers it for that provider and model', async () => {
    resetAgent(LOCAL);
    seedApp();
    const provider = fakeProvider('openai', [
      { error: { status: 400, body: { error: { message: 'registry.ollama.ai/library/x does not support tools' } } } },
      (body) => {
        expect(body.tools).toBeUndefined();
        expect((body.messages as Array<{ content: string }>)[0].content).toContain('## Calling tools (text protocol)');
        return { text: 'Reading first.', calls: [{ name: 'read_file', input: { path: 'ui/main.ui' } }] };
      },
      (body) => {
        const last = (body.messages as Array<{ role: string; content: string }>).at(-1)!;
        expect(last.role).toBe('user');
        expect(last.content).toContain('<tool_result name="read_file" status="ok">');
        return { calls: [{ name: 'finish', input: { summary: 'Read it.' } }] };
      },
    ]);
    say('Look');
    await startAgentRun();
    expect(lastRun().run.status).toBe('finished');
    expect(lastRun().run.protocol).toBe('text');
    expect(useAIStore.getState().toolProtocols['l:model-under-test']).toBe('text');
    expect(provider.count()).toBe(3);

    // The next run goes straight to text.
    const next = fakeProvider('openai', [{ calls: [{ name: 'finish', input: { summary: 'ok' } }] }]);
    say('Again');
    await startAgentRun();
    expect(next.bodies[0].tools).toBeUndefined();
  });

  it('moves to the text protocol when a native reply writes its calls as text', async () => {
    resetAgent(OPENAI);
    seedApp();
    fakeProvider('text-openai', [
      { calls: [{ name: 'read_file', input: { path: 'ui/main.ui' } }] },
      { calls: [{ name: 'finish', input: { summary: 'ok' } }] },
    ]);
    say('Look');
    await startAgentRun();
    expect(lastRun().run.protocol).toBe('text');
    expect(toolEntries().map((e) => [e.name, e.status])).toEqual([['read_file', 'ok'], ['finish', 'ok']]);
  });

  it('runs a whole build over the text protocol with Anthropic', async () => {
    useAIStore.setState({ toolProtocols: { 'a:model-under-test': 'text' } });
    const provider = fakeProvider('text-anthropic', [
      { calls: [{ name: 'write_file', input: { path: 'manifest.json', content: APP.manifest } }, { name: 'write_file', input: { path: 'ui/main.ui', content: APP.ui } }, { name: 'write_file', input: { path: 'logic/main.logic', content: APP.logic } }] },
      { calls: [{ name: 'finish', input: { summary: 'Built.' } }] },
    ]);
    say('Build');
    await startAgentRun();
    expect(provider.bodies[0].tools).toBeUndefined();
    expect(lastRun().run.status).toBe('finished');
    expect(text('logic/main.logic')).toBe(APP.logic);
  });

  it('tells the model when a <tool_call> it wrote could not be read, instead of ending the run', async () => {
    resetAgent(LOCAL);
    seedApp();
    useAIStore.setState({ toolProtocols: { 'l:model-under-test': 'text' } });
    fakeProvider('text-openai', [
      { text: 'Listing.\n<tool_call name="list_files">' },
      (body) => {
        expect((body.messages as Array<{ content: string }>).at(-1)!.content).toMatch(/could not be read, so nothing was run/);
        return { calls: [{ name: 'finish', input: { summary: 'ok' } }] };
      },
    ]);
    say('Look');
    await startAgentRun();
    expect(lastRun().run.status).toBe('finished');
  });
});

describe('a model that answers in text instead of calling tools', () => {
  it('does not report a build that wrote nothing as done', async () => {
    useWorkspaceStore.getState().setBrief({
      appName: 'Counter', description: 'A counter', target: 'web', pages: ['Home'], collections: [], authNeeded: false, style: 'clean', referenceImages: [],
    });
    // As a small local model did: file content as a code block, then an echo of the nudge.
    fakeProvider('anthropic', [{ text: '```json\n{"name": "Counter"}\n```' }, { text: 'Finish. What you built or changed?' }]);
    say('Build the app');
    await startAgentRun({ kind: 'build' });
    const { run } = lastRun();
    expect(run.status).toBe('failed');
    expect(run.summary).toBeUndefined();
    expect(run.reason).toMatch(/stopped without building anything/);
  });

  it('still lets an edit run end with a plain answer', async () => {
    seedApp();
    fakeProvider('anthropic', [{ text: 'The app counts tasks.' }, { text: 'Nothing to change.' }]);
    say('What does this app do?');
    await startAgentRun();
    expect(lastRun().run.status).toBe('finished');
    expect(lastRun().run.summary).toBe('Nothing to change.');
  });
});

describe('context compaction', () => {
  it('replaces long reads older than a few steps with a note, keeping the latest check', async () => {
    seedApp();
    useVFSStore.getState().hydrateFiles([
      { path: 'manifest.json', content: APP.manifest },
      { path: 'ui/main.ui', content: APP.ui },
      { path: 'logic/main.logic', content: APP.logic },
      { path: 'data/big.json', content: JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => ({ i, text: 'row text '.repeat(3) })) }, null, 2) },
    ]);
    const read = { calls: [{ name: 'read_file', input: { path: 'data/big.json' } }] };
    const list = { calls: [{ name: 'list_files', input: {} }] };
    const script = [read, ...Array.from({ length: 11 }, () => list), (body: Record<string, unknown>) => {
      const sent = resultsIn(body);
      expect(sent).toContain('[read_file result from step 1');
      expect(sent).not.toContain('row text row text row text');
      return { calls: [{ name: 'finish', input: { summary: 'ok' } }] };
    }];
    fakeProvider('anthropic', script);
    say('Read a lot');
    await startAgentRun();
    expect(lastRun().run.status).toBe('finished');
  });
});

describe('the text protocol parser', () => {
  it('reads <arg> values raw — including markup and a literal </arg> — and JSON bodies, and typed values by schema', () => {
    const parsed = parseTextToolCalls(`Here.
<tool_call name="edit_file">
<arg name="path">ui/main.ui</arg>
<arg name="old_string"><Text>a</Text></arg>
<arg name="new_string"><Text>say </arg> safely</Text></arg>
<arg name="replace_all">true</arg>
</tool_call>
<tool_call name="read_file">{"path": "logic/main.logic", "start_line": 2}</tool_call>
<tool_call name="update_plan">
<arg name="items">[{"text": "One", "status": "done"}]</arg>
</tool_call>`);
    expect(parsed.text).toBe('Here.');
    expect(parsed.calls.map((c) => c.name)).toEqual(['edit_file', 'read_file', 'update_plan']);
    expect(parsed.calls[0].input).toEqual({ path: 'ui/main.ui', old_string: '<Text>a</Text>', new_string: '<Text>say </arg> safely</Text>', replace_all: true });
    expect(parsed.calls[1].input).toEqual({ path: 'logic/main.logic', start_line: 2 });
    expect(parsed.calls[2].input).toEqual({ items: [{ text: 'One', status: 'done' }] });
  });

  it('answers an unreadable call with why, reads the old file-block format as write_file, and ignores results the model wrote itself', () => {
    const parsed = parseTextToolCalls('<tool_call name="read_file">{path: nope}</tool_call>\n<softn-file path="ui/a.ui">\n<App/>\n</softn-file>\n<tool_result name="x">made up</tool_result>');
    expect(parsed.calls[0].parseError).toMatch(/neither <arg> elements nor a JSON object/);
    expect(parsed.calls[1]).toMatchObject({ name: 'write_file', input: { path: 'ui/a.ui', content: '<App/>' } });
    expect(parsed.text).toBe('');
  });

  it('takes an empty-bodied call out of the text too, and reads the self-closing form with attribute arguments', () => {
    // Both as real models wrote them: an argument-less block after another call, and a self-closing tag.
    const empty = parseTextToolCalls('<tool_call name="update_plan">\n<arg name="items">[{"text": "List", "status": "active"}]</arg>\n</tool_call>\n<tool_call name="list_files">\n</tool_call>');
    expect(empty.calls.map((c) => [c.name, c.input])).toEqual([['update_plan', { items: [{ text: 'List', status: 'active' }] }], ['list_files', {}]]);
    expect(empty.text).toBe('');
    const selfClosing = parseTextToolCalls('Looking.\n<tool_call name="read_file" path="ui/main.ui" start_line="3" />');
    expect(selfClosing.calls.map((c) => [c.name, c.input])).toEqual([['read_file', { path: 'ui/main.ui', start_line: 3 }]]);
    expect(selfClosing.text).toBe('Looking.');
  });
});
