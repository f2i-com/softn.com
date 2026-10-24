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
  runRevertState,
  setAgentEnvironment,
  startAgentRun,
  stepUndoState,
  stopAgentRun,
  undoAgentStep,
} from '../src/lib/agent/runAgent';
import { executeTool } from '../src/lib/agent/executeTool';
import { parseTextToolCalls } from '../src/lib/agent/protocol';
import type { SuppliedFiles } from '../src/lib/changeset';
import { useAIStore } from '../src/stores/aiStore';
import { useVFSStore } from '../src/stores/vfsStore';
import { useWorkspaceStore } from '../src/stores/workspaceStore';
import { APP, assertScriptsPassed, fakeProvider, lastRun, LOCAL, nodeEnvironment, OPENAI, resetAgent, resultsIn, say, seedApp, text } from './helpers/agentHarness';

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
    // In a whole app: a run does not finish over a check that failed, so the fixture has to pass one.
    useVFSStore.getState().hydrateFiles([{ path: 'manifest.json', content: APP.manifest }, { path: 'ui/main.ui', content: APP.ui }, { path: 'logic/main.logic', content: APP.logic }, { path: 'ui/list.ui', content: '<Text>a</Text>\n<Text>a</Text>' }]);
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

  it('edits across line endings: an old_string written with \\n matches a file that has \\r\\n, and the file keeps its own', async () => {
    // A bundle written on Windows keeps its \r\n. read_file shows the lines, the model writes
    // them back joined by \n, and no edit of more than one line ever matched: "old_string was
    // not found … check the indentation and line breaks", three times, and the run stopped.
    // (In a whole app, as above: the run has to be able to finish.)
    useVFSStore.getState().hydrateFiles([{ path: 'manifest.json', content: APP.manifest }, { path: 'ui/main.ui', content: APP.ui }, { path: 'logic/main.logic', content: APP.logic }, { path: 'ui/win.ui', content: '<App>\r\n  <Text>one</Text>\r\n  <Text>two</Text>\r\n</App>\r\n' }]);
    fakeProvider('openai', [
      {
        calls: [
          { name: 'read_file', input: { path: 'ui/win.ui' } },
          { name: 'edit_file', input: { path: 'ui/win.ui', old_string: '  <Text>one</Text>\n  <Text>two</Text>', new_string: '  <Text>1</Text>\n  <Text>2</Text>\n  <Text>3</Text>' } },
        ],
      },
      { calls: [{ name: 'finish', input: { summary: 'done' } }] },
    ]);
    say('Renumber');
    await startAgentRun();
    expect(toolEntries().find((e) => e.name === 'edit_file')?.status).toBe('ok');
    expect(text('ui/win.ui')).toBe('<App>\r\n  <Text>1</Text>\r\n  <Text>2</Text>\r\n  <Text>3</Text>\r\n</App>\r\n');
  });
});

describe('tool calls that arrive without an id', () => {
  it('gives each one its own, so a later step does not write over the rows of the steps before it', async () => {
    // Some OpenAI-compatible servers send no id. Every call was then "call_0", the timeline is
    // kept by id, and each finished step rewrote all the rows before it: after two writes both
    // rows read "Finished.", with no path, no diff and no Undo.
    resetAgent(LOCAL);
    seedApp();
    const provider = fakeProvider('openai', [
      { calls: [{ name: 'write_file', input: { path: 'ui/one.ui', content: '<App><Text>1</Text></App>' } }], noCallIds: true },
      { calls: [{ name: 'write_file', input: { path: 'ui/two.ui', content: '<App><Text>2</Text></App>' } }], noCallIds: true },
      { calls: [{ name: 'finish', input: { summary: 'Two files.' } }], noCallIds: true },
    ]);
    say('Two files');
    await startAgentRun();
    expect(lastRun().run.status).toBe('finished');
    const writes = toolEntries().filter((e) => e.name === 'write_file');
    expect(writes.map((e) => e.subject)).toEqual(['ui/one.ui', 'ui/two.ui']);
    expect(writes.map((e) => e.diff?.[0].path)).toEqual(['ui/one.ui', 'ui/two.ui']);
    expect(writes.every((e) => e.transactionId)).toBe(true);
    expect(new Set(toolEntries().map((e) => e.id)).size).toBe(toolEntries().length);
    // The wire still pairs each result with the call it answers.
    const messages = provider.bodies[2].messages as Array<{ role: string; tool_call_id?: string; tool_calls?: Array<{ id: string }> }>;
    const ids = messages.filter((m) => m.role === 'assistant').flatMap((m) => m.tool_calls ?? []).map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
    expect(messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(ids);
  });

  // The Messages decoder still named an id-less call by its place in the reply, the rule the
  // other decoder gave up: a gateway that speaks this API and leaves ids out had every step
  // rewrite the rows before it, and its echoed tool_use blocks went back with no id to pair.
  it('gives each its own over the Messages API too, and echoes the call with the id its result answers', async () => {
    // In a whole app: a run does not finish over a check that failed, so the fixture has to pass one.
    seedApp();
    const provider = fakeProvider('anthropic', [
      { calls: [{ name: 'write_file', input: { path: 'ui/one.ui', content: '<App><Text>1</Text></App>' } }], noCallIds: true },
      { calls: [{ name: 'write_file', input: { path: 'ui/two.ui', content: '<App><Text>2</Text></App>' } }], noCallIds: true },
      { calls: [{ name: 'finish', input: { summary: 'Two files.' } }], noCallIds: true },
    ]);
    say('Two files');
    await startAgentRun();
    expect(lastRun().run.status).toBe('finished');
    const writes = toolEntries().filter((e) => e.name === 'write_file');
    expect(writes.map((e) => e.subject)).toEqual(['ui/one.ui', 'ui/two.ui']);
    expect(writes.map((e) => e.diff?.[0].path)).toEqual(['ui/one.ui', 'ui/two.ui']);
    expect(new Set(toolEntries().map((e) => e.id)).size).toBe(toolEntries().length);
    const messages = provider.bodies[2].messages as Array<{ role: string; content: Array<{ type: string; id?: string; tool_use_id?: string }> }>;
    const used = messages.filter((m) => m.role === 'assistant').flatMap((m) => m.content).filter((b) => b.type === 'tool_use').map((b) => b.id);
    const answered = messages.filter((m) => m.role === 'user').flatMap((m) => m.content).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id);
    expect(used.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(used).size).toBe(2);
    expect(answered).toEqual(used);
  });
});

describe('reading a file', () => {
  beforeEach(() => seedApp());

  it('cuts one very long line at the size cap and says so, and does not count it as read whole', async () => {
    // The cap kept at least one line, so a file that is one line — a compact .xdb, a minified
    // script — came back whole: hundreds of thousands of characters into the conversation,
    // marked "complete".
    const long = JSON.stringify({ collection: 'big', records: Array.from({ length: 5000 }, (_, i) => ({ id: String(i), title: `Record number ${i}` })) });
    useVFSStore.getState().createFile('data/big.xdb', long);
    const seen: SuppliedFiles = new Map();
    const context = { seen, env: nodeEnvironment, blueprint: null, newTransactionId: () => crypto.randomUUID() };
    const read = await executeTool({ id: 'r', name: 'read_file', input: { path: 'data/big.xdb' } }, context);
    expect(read.isError).toBe(false);
    expect(read.content.length).toBeLessThan(41_000);
    expect(read.content.split('\n')[0]).toMatch(/^data\/big\.xdb line 1 of 1, cut: the first 40,000 of its [\d,]+ characters are shown/);
    expect(read.content).toContain('{"collection":"big"');
    // What was not shown was not read: replacing the file whole is still refused.
    expect(seen.get('data/big.xdb')?.complete).toBe(false);
    const write = await executeTool({ id: 'w', name: 'write_file', input: { path: 'data/big.xdb', content: '{}' } }, context);
    expect(write.isError).toBe(true);
    expect(write.content).toContain('You have read only part of data/big.xdb');
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

  // read_file, edit_file and delete_file took a path written from the root with "./"; the two
  // tools that name a new path refused the same spelling as "not a project path".
  it('takes a path written with a leading ./ wherever a path is given, to write and rename as to read', async () => {
    const seen: SuppliedFiles = new Map();
    const ctx = { seen, env: nodeEnvironment, blueprint: null, newTransactionId: () => `t-${Math.random()}` };
    const call = (name: string, input: Record<string, unknown>) => executeTool({ id: `c-${Math.random()}`, name, input }, ctx);

    expect((await call('read_file', { path: './ui/main.ui' })).isError).toBe(false);
    const written = await call('write_file', { path: './ui/pages/about.ui', content: '<Text>About</Text>' });
    expect(written.content).toBe('Created ui/pages/about.ui (1 lines, +1 −0).');
    expect(text('ui/pages/about.ui')).toBe('<Text>About</Text>');
    const renamed = await call('rename_file', { from: './ui/pages/about.ui', to: './ui/pages/team.ui' });
    expect(renamed.isError).toBe(false);
    expect(text('ui/pages/team.ui')).toBe('<Text>About</Text>');
    expect((await call('list_files', { prefix: './ui/pages/' })).content).toContain('ui/pages/team.ui');
    // A path that leaves the project is still refused.
    expect((await call('write_file', { path: './../escape.ui', content: '<App/>' })).isError).toBe(true);
  });

  // rename_file had no "seen" check, and recorded the new path as read at the file's current
  // version: a write built on the text from before the person's edit was taken there.
  it('renames a file only as the model saw it, and the new path counts as read only if it was', async () => {
    const seen: SuppliedFiles = new Map();
    const ctx = { seen, env: nodeEnvironment, blueprint: null, newTransactionId: () => `t-${Math.random()}` };
    const call = (name: string, input: Record<string, unknown>) => executeTool({ id: `c-${Math.random()}`, name, input }, ctx);
    useVFSStore.getState().createFile('notes.md', 'line one\n', 'user');
    expect((await call('read_file', { path: 'notes.md' })).isError).toBe(false);
    useVFSStore.getState().updateFile('notes.md', "line one\nthe person's paragraph\n", 'user');

    const renamed = await call('rename_file', { from: 'notes.md', to: 'readme.md' });
    expect(renamed.isError).toBe(true);
    expect(renamed.content).toContain('changed since you read it');
    expect(text('notes.md')).toBe("line one\nthe person's paragraph\n");

    // Never read: renamed, but a write on the new path still needs a read first.
    useVFSStore.getState().createFile('todo.md', 'mine\n', 'user');
    expect((await call('rename_file', { from: 'todo.md', to: 'tasks.md' })).isError).toBe(false);
    const write = await call('write_file', { path: 'tasks.md', content: 'model text\n' });
    expect(write.isError).toBe(true);
    expect(text('tasks.md')).toBe('mine\n');
  });

  it('writes an SVG, a CSV and a file with no extension as the text they are, and refuses only what is kept as bytes', async () => {
    // Whatever core's registry does not list as text was refused as "a binary format": a .csv, a
    // README, and an .svg too — in a message that ended "or use an SVG or text format".
    fakeProvider('anthropic', [
      {
        calls: [
          { name: 'write_file', input: { path: 'assets/icon.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"/>' } },
          { name: 'write_file', input: { path: 'data/tasks.csv', content: 'title,done\nBuy milk,false\n' } },
          { name: 'write_file', input: { path: 'README', content: 'Tasks' } },
          { name: 'write_file', input: { path: 'assets/photo.png', content: 'not bytes' } },
          { name: 'write_file', input: { path: 'assets/theme.zip', content: 'not bytes' } },
        ],
      },
      (body) => {
        const sent = resultsIn(body);
        expect(sent).toContain('assets/photo.png is a binary format (image/png)');
        expect(sent).toContain('assets/theme.zip is a binary format');
        expect(sent).toContain('draw it as an .svg file');
        expect(sent).not.toContain('or use an SVG or text format');
        return { calls: [{ name: 'finish', input: { summary: 'Wrote the text files.' } }] };
      },
    ]);
    say('Add an icon and some data');
    await startAgentRun();
    expect(text('assets/icon.svg')).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(text('data/tasks.csv')).toBe('title,done\nBuy milk,false\n');
    expect(text('README')).toBe('Tasks');
    expect(useVFSStore.getState().files.has('assets/photo.png')).toBe(false);
    expect(useVFSStore.getState().files.has('assets/theme.zip')).toBe(false);
    expect(toolEntries().filter((e) => e.name === 'write_file').map((e) => e.status)).toEqual(['ok', 'ok', 'ok', 'error', 'error']);
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
    // In a whole app: a run does not finish over a check that failed, so the fixture has to pass one.
    useVFSStore.getState().hydrateFiles([{ path: 'manifest.json', content: APP.manifest }, { path: 'ui/main.ui', content: APP.ui }, { path: 'logic/main.logic', content: APP.logic }, ...['a', 'b', 'c', 'd', 'e'].map((n) => ({ path: `ui/${n}.ui`, content: '<App/>' }))]);
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

  it('continues after a token-budget stop: the budget becomes what was spent plus the setting as it is now', async () => {
    // The budget was extended only once nine tenths of it were spent. The stop reserves the
    // next request and a whole reply, often more than the last tenth, so Continue failed again
    // at once without sending anything — and so did raising the budget in Settings, the other
    // thing the message says to do.
    useAIStore.getState().updateAgentSettings({ runTokenBudget: 10_000 });
    const provider = fakeProvider('anthropic', [{ calls: [{ name: 'finish', input: { summary: 'ok' } }] }]);
    say('Go');
    await startAgentRun();
    let { run } = lastRun();
    expect(run.reason).toMatch(/run's token budget would be exceeded/);
    expect(provider.count()).toBe(0);
    useAIStore.getState().updateAgentSettings({ runTokenBudget: 2_000_000 });
    await continueAgentRun(run.id);
    ({ run } = lastRun());
    expect(provider.count()).toBe(1);
    expect(run.tokenBudget).toBe(2_000_000);
    expect(run.status).toBe('finished');
  });

  it('grants another allowance on Continue however little of the budget was spent when the run stopped', async () => {
    // Two thirds spent, and a reply's reservation larger than what was left: under nine tenths,
    // so Continue changed nothing.
    useAIStore.setState({ maxOutputTokens: 50_000 });
    useAIStore.getState().updateAgentSettings({ runTokenBudget: 150_000 });
    const provider = fakeProvider('anthropic', [
      { calls: [{ name: 'list_files', input: {} }], usage: { input: 100_000, output: 1_000 } },
      { calls: [{ name: 'finish', input: { summary: 'ok' } }] },
    ]);
    say('Go');
    await startAgentRun();
    let { run } = lastRun();
    expect(run.status).toBe('failed');
    expect(run.reason).toMatch(/run's token budget would be exceeded: 101,000 of 150,000/);
    expect(provider.count()).toBe(1);
    await continueAgentRun(run.id);
    ({ run } = lastRun());
    expect(run.tokenBudget).toBe(251_000);
    expect(provider.count()).toBe(2);
    expect(run.status).toBe('finished');
  });

  it('stays stopped when Stop lands during the automatic check, and answers each call once', async () => {
    // Stop answered the step's calls. The check then came back, answered them a second time —
    // so every later request carried two results for one call — and, the reply having also
    // called finish, turned the run the person had stopped into a finished one.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let checks = 0;
    setAgentEnvironment({
      ...nodeEnvironment,
      checkApp: async (files, options) => {
        checks++;
        await held;
        return nodeEnvironment.checkApp(files, options);
      },
    });
    const provider = fakeProvider('anthropic', [
      { calls: [{ name: 'write_file', input: { path: 'ui/late.ui', content: '<App/>' } }, { name: 'finish', input: { summary: 'Done.' } }] },
      { calls: [{ name: 'finish', input: { summary: 'Resumed and done.' } }] },
    ]);
    say('Go');
    const running = startAgentRun();
    await vi.waitFor(() => expect(checks).toBe(1));
    stopAgentRun();
    release();
    await running;
    expect(lastRun().run.status).toBe('stopped');
    // The check's row is not left spinning.
    expect(toolEntries().find((e) => e.auto)?.status).not.toBe('running');
    await continueAgentRun(lastRun().run.id);
    const blocks = (provider.bodies[1].messages as Array<{ content: unknown }>).flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; tool_use_id?: string }>) : []));
    const answered = blocks.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id);
    expect(answered).toHaveLength(2);
    expect(new Set(answered).size).toBe(2);
    expect(lastRun().run.summary).toBe('Resumed and done.');
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

  it('never applies a reply cut off at the output limit, and tries the step again asking for shorter reasoning', async () => {
    // From a real run: a reasoning model spent ~12k of a 16,384-token allowance thinking, and its reply was cut.
    const provider = fakeProvider('anthropic', [
      { calls: [{ name: 'write_file', input: { path: 'ui/cut.ui', content: '<App>' } }], stop: 'max_tokens', usage: { input: 500, output: 4_096 } },
      (body) => {
        expect(resultsIn(body)).toContain('cut off at the output limit (4,096 tokens)');
        expect(resultsIn(body)).toMatch(/keep your reasoning short, and split the work/);
        return { calls: [{ name: 'finish', input: { summary: 'ok' } }] };
      },
    ]);
    say('Go');
    await startAgentRun();
    expect(provider.count()).toBe(2);
    // Every request goes out with the setting as the provider's output cap.
    expect(provider.bodies.every((b) => b.max_tokens === 4_096)).toBe(true);
    expect(useVFSStore.getState().files.has('ui/cut.ui')).toBe(false);
    const { run } = lastRun();
    expect(run.status).toBe('finished');
    // The cut reply's tokens are counted like any other's.
    expect(run.tokens.output).toBe(4_096 + 20);
    expect(run.entries.some((e) => e.kind === 'text' && /tried again/.test(e.text))).toBe(true);
  });

  it('stops when the retried step is cut off at the output limit again, and points at the setting', async () => {
    const provider = fakeProvider('anthropic', [
      { calls: [{ name: 'write_file', input: { path: 'ui/cut.ui', content: '<App>' } }], stop: 'max_tokens' },
      { calls: [{ name: 'write_file', input: { path: 'ui/cut.ui', content: '<App>' } }], stop: 'max_tokens' },
    ]);
    say('Go');
    await startAgentRun();
    expect(provider.count()).toBe(2);
    const { run } = lastRun();
    expect(run.status).toBe('failed');
    expect(run.reason).toMatch(/cut off at the output limit \(4,096 tokens\) again .* Raise Max output tokens in Settings → Agent runs/);
    expect(useVFSStore.getState().files.has('ui/cut.ui')).toBe(false);
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

  // Every request reserves Max output tokens as the provider's output cap, and the default is
  // above what many models allow. Those providers answer 400 before reading anything else, so
  // with the settings as they come the first request of every run was refused, and the reason
  // ended "Check your API key and provider settings", which the connection test had just passed.
  it('asks again with the most the model allows when the provider says the output limit set is over it, and remembers it for that model', async () => {
    const provider = fakeProvider('anthropic', [
      { error: { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: 4096 > 2048, which is the maximum allowed number of output tokens for model-under-test' } } } },
      { calls: [{ name: 'finish', input: { summary: 'ok' } }] },
    ]);
    say('Go');
    await startAgentRun();
    const { run } = lastRun();
    expect(run.status).toBe('finished');
    expect(provider.bodies.map((b) => b.max_tokens)).toEqual([4_096, 2_048]);
    // The person is told, since the setting they see is no longer the number in use.
    expect(run.entries.some((e) => e.kind === 'text' && /at most 2,048 output tokens/.test(e.text))).toBe(true);

    // The next run starts at the model's limit instead of being refused once more.
    const next = fakeProvider('anthropic', [{ calls: [{ name: 'finish', input: { summary: 'ok' } }] }]);
    say('Again');
    await startAgentRun();
    expect(next.bodies.map((b) => b.max_tokens)).toEqual([2_048]);
  });

  it('reads the limit from an OpenAI-compatible refusal too, whichever field carried the cap', async () => {
    resetAgent(OPENAI);
    seedApp();
    const provider = fakeProvider('openai', [
      { error: { status: 400, body: { error: { message: 'max_completion_tokens is too large: 4096. This model supports at most 1024 completion tokens, whereas you provided 4096.', type: 'invalid_request_error' } } } },
      { calls: [{ name: 'finish', input: { summary: 'ok' } }] },
    ]);
    say('Go');
    await startAgentRun();
    expect(lastRun().run.status).toBe('finished');
    expect(provider.bodies.map((b) => b.max_completion_tokens)).toEqual([4_096, 1_024]);
  });

  it('points at the setting, not the API key, when a refused output limit names no number to use, and asks once only', async () => {
    const refusal = { error: { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens is larger than this model allows' } } } };
    const provider = fakeProvider('anthropic', [refusal]);
    say('Go');
    await startAgentRun();
    const { run } = lastRun();
    expect(provider.count()).toBe(1);
    expect(run.status).toBe('failed');
    expect(run.reason).toContain('max_tokens is larger than this model allows');
    expect(run.reason).toMatch(/Max output tokens \(Settings → Agent runs\)/);
    expect(run.reason).not.toMatch(/API key/);
  });

  it('says the limit is the model’s own when a reply is cut at a limit the provider named, where raising the setting would change nothing', async () => {
    const cut = { calls: [{ name: 'write_file', input: { path: 'ui/cut.ui', content: '<App>' } }], stop: 'max_tokens' };
    fakeProvider('anthropic', [
      { error: { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: 4096 > 2048, which is the maximum allowed number of output tokens for model-under-test' } } } },
      cut,
      cut,
    ]);
    say('Go');
    await startAgentRun();
    const { run } = lastRun();
    expect(run.status).toBe('failed');
    expect(run.reason).toMatch(/cut off at the output limit \(2,048 tokens\) again/);
    expect(run.reason).toMatch(/the most this model allows in one reply/);
    expect(run.reason).not.toMatch(/Raise Max output tokens/);
  });

  // A server that counts the prompt and the reply against one context window refuses the same
  // field in words that name the window and the prompt's size. Neither is the model's output
  // limit: read as one, it was asked for again, refused again, and kept for the page, so every
  // later reply on that model was cut short at a number the provider never set.
  it('does not take a context-window refusal for the model’s output limit', async () => {
    resetAgent(LOCAL);
    seedApp();
    const provider = fakeProvider('openai', [
      { error: { status: 400, body: { error: { message: '\'max_tokens\' or \'max_completion_tokens\' is too large: 4096. This model\'s maximum context length is 3000 tokens and your request has 2500 input tokens (4096 > 3000 - 2500).' } } } },
    ]);
    say('Go');
    await startAgentRun();
    const { run } = lastRun();
    expect(provider.count()).toBe(1);
    expect(run.status).toBe('failed');
    expect(useAIStore.getState().outputLimits).toEqual({});
    expect(run.reason).toContain('maximum context length is 3000 tokens');
    expect(run.reason).not.toMatch(/API key/);
  });

  // An overloaded or unreachable upstream is the provider's "try again in a moment", which a
  // streamed reply already got (an overloaded error event is retried as a rate limit): the
  // same answer as a status ended the run, with a reason that sent the person to their API key.
  it('waits and asks again when the provider’s server is overloaded, as it does for a rate limit', async () => {
    const provider = fakeProvider('anthropic', [
      { error: { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } } },
      { error: { status: 503, body: { type: 'error', error: { type: 'api_error', message: 'Service unavailable' } } } },
      { calls: [{ name: 'finish', input: { summary: 'Back.' } }] },
    ]);
    say('Go');
    await startAgentRun();
    expect(lastRun().run.status).toBe('finished');
    expect(provider.count()).toBe(3);
  });

  it('pauses, with Resume and no word about the API key, when the provider’s server stays overloaded', async () => {
    const overloaded = { error: { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } } };
    const provider = fakeProvider('anthropic', [overloaded, overloaded, overloaded, overloaded, { calls: [{ name: 'finish', input: { summary: 'Back.' } }] }]);
    say('Go');
    await startAgentRun();
    let { run } = lastRun();
    expect(provider.count()).toBe(4);
    expect(run.status).toBe('paused');
    expect(run.reason).toMatch(/had an error of its own \(529\)\. Try again in a moment\./);
    expect(run.reason).toMatch(/Resume sends the request again/);
    expect(run.reason).not.toMatch(/API key/);
    await continueAgentRun(run.id);
    ({ run } = lastRun());
    expect(run.status).toBe('finished');
    // Resumed, not told anything new: the request that was refused is the request sent again.
    expect(provider.bodies[4].messages).toEqual(provider.bodies[0].messages);
  });

  // One count was kept for both kinds of second chance, so a request that had waited out a
  // rate limit had already used the one retry a timeout gets.
  it('tries a timed-out request once more even after waiting out a rate limit on it', async () => {
    useAIStore.setState({ requestTimeoutMs: 40 });
    const provider = fakeProvider('anthropic', [
      { error: { status: 429, body: { error: { message: 'slow down' } }, headers: { 'retry-after': '0' } } },
      { stall: true },
      { calls: [{ name: 'finish', input: { summary: 'ok' } }] },
    ]);
    say('Go');
    await startAgentRun();
    expect(provider.count()).toBe(3);
    expect(lastRun().run.status).toBe('finished');
  });

  it('tries a timed-out request once more, once: a second timeout pauses the run', async () => {
    useAIStore.setState({ requestTimeoutMs: 40 });
    const provider = fakeProvider('anthropic', [{ stall: true }, { stall: true }, { calls: [{ name: 'finish', input: { summary: 'ok' } }] }]);
    say('Go');
    await startAgentRun();
    expect(provider.count()).toBe(2);
    expect(lastRun().run.status).toBe('paused');
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

  it('after Revert run and Continue, tells the model its files were put back, and what it does next can be undone', async () => {
    // The run stayed marked as reverted: the steps it made after Continue had no Undo and no
    // Revert run, and the model was told only to carry on, as though its files were still there.
    useAIStore.getState().updateAgentSettings({ maxSteps: 5 });
    const list = { name: 'list_files', input: {} };
    fakeProvider('anthropic', [
      { calls: [{ name: 'write_file', input: { path: 'ui/one.ui', content: '<App><Text>1</Text></App>' } }, list, list, list, list] },
      (body) => {
        expect(resultsIn(body)).toContain('The person reverted this run');
        return { calls: [{ name: 'write_file', input: { path: 'ui/two.ui', content: '<App><Text>2</Text></App>' } }] };
      },
      { calls: [{ name: 'finish', input: { summary: 'Wrote it again.' } }] },
    ]);
    say('Go');
    await startAgentRun();
    let { run, message } = lastRun();
    expect(run.reason).toMatch(/limit of 5 steps/);
    expect(revertAgentRun(message.id).ok).toBe(true);
    expect(useVFSStore.getState().files.has('ui/one.ui')).toBe(false);
    await continueAgentRun(run.id);
    ({ run, message } = lastRun());
    expect(run.status).toBe('finished');
    // The step taken since is the run's to undo and to revert; the reverted ones stay undone.
    expect(run.reverted).toBeFalsy();
    const second = toolEntries().find((e) => e.subject === 'ui/two.ui')!;
    expect(stepUndoState(second)).toEqual({ kind: 'available' });
    expect(stepUndoState(toolEntries().find((e) => e.subject === 'ui/one.ui')!)).toEqual({ kind: 'undone' });
    expect(runRevertState(run).available).toBe(true);
    expect(revertAgentRun(message.id)).toEqual({ ok: true, paths: ['ui/two.ui'] });
    expect(useVFSStore.getState().files.has('ui/two.ui')).toBe(false);
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

  // A 500 is a server tripping over a request. Some trip over `tools` and say so, and the run
  // is right to carry on in text; but one bad moment on a server that does take tools was
  // written down as "this model never takes tools", for every run after, with no way to undo it.
  it('moves only this run to the text protocol when a server error reads like refused `tools`, and remembers nothing', async () => {
    resetAgent(LOCAL);
    seedApp();
    const provider = fakeProvider('openai', [
      { error: { status: 500, body: { error: { message: 'template error: this model does not support tools' } } } },
      (body) => {
        expect(body.tools).toBeUndefined();
        return { text: 'Reading first.', calls: [{ name: 'read_file', input: { path: 'ui/main.ui' } }] };
      },
      (body) => {
        // The run stays in text: it does not go back to `tools` and meet the same error at every step.
        expect(body.tools).toBeUndefined();
        return { calls: [{ name: 'finish', input: { summary: 'Read it.' } }] };
      },
    ]);
    say('Look');
    await startAgentRun();
    const { run } = lastRun();
    expect(run.status).toBe('finished');
    expect(run.protocol).toBe('text');
    expect(provider.count()).toBe(3);
    expect(useAIStore.getState().toolProtocols).toEqual({});
    expect(run.entries.some((e) => e.kind === 'text' && /the next run tries tool calls again/.test(e.text))).toBe(true);

    // The next run asks with `tools` again.
    const next = fakeProvider('openai', [
      (body) => {
        expect(body.tools).toBeDefined();
        return { calls: [{ name: 'finish', input: { summary: 'ok' } }] };
      },
    ]);
    say('Again');
    await startAgentRun();
    expect(next.count()).toBe(1);
    expect(lastRun().run.protocol).toBe('openai');
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

  // What a project's own text can say, quoted or written into a file, is not a call: read as
  // one, a README or a note of the model's wrote over files of the project.
  it('reads a file block inside a call’s value as that value, not as a write of its own', () => {
    const parsed = parseTextToolCalls([
      'Adding the help page.',
      '<tool_call name="write_file">',
      '<arg name="path">pages/help.md</arg>',
      '<arg name="content"># How the old Studio wrote files',
      '<softn-file path="logic/main.js">export function hello() { return 1 }</softn-file>',
      '</arg>',
      '</tool_call>',
    ].join('\n'));
    expect(parsed.calls.map((c) => [c.name, c.input.path])).toEqual([['write_file', 'pages/help.md']]);
    expect(parsed.calls[0].input.content).toContain('<softn-file path="logic/main.js">');
  });

  it('reads a call written inside another call’s value as part of that value', () => {
    const parsed = parseTextToolCalls([
      '<tool_call name="write_file">',
      '<arg name="path">docs/agent-notes.md</arg>',
      '<arg name="content">An example call:',
      '<tool_call name="delete_file"><arg name="path">index.html</arg></tool_call>',
      'end of notes</arg>',
      '</tool_call>',
    ].join('\n'));
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0]).toMatchObject({ name: 'write_file', input: { path: 'docs/agent-notes.md' } });
    expect(parsed.calls[0].input.content).toBe('An example call:\n<tool_call name="delete_file"><arg name="path">index.html</arg></tool_call>\nend of notes');
    expect(parsed.text).toBe('');
  });

  it('takes the first of an argument’s name as the argument, and a call whose close is missing ends at the last one', () => {
    const twice = parseTextToolCalls('<tool_call name="write_file">\n<arg name="path">notes.md</arg>\n<arg name="content">x</arg>\n<arg name="path">index.html</arg>\n</tool_call>');
    expect(twice.calls[0].input.path).toBe('notes.md');
    const unclosedInside = parseTextToolCalls('<tool_call name="write_file">\n<arg name="path">notes.md</arg>\n<arg name="content">shows <tool_call name="x"> half a tag</arg>\n</tool_call>');
    expect(unclosedInside.calls.map((c) => [c.name, c.input.path])).toEqual([['write_file', 'notes.md']]);
  });

  it('does not take a file block quoted in a sentence for a write, natively or as text', async () => {
    const { decodeOpenAI } = await import('../src/lib/agent/protocol');
    const reply = decodeOpenAI({
      choices: [{ finish_reason: 'stop', message: { content: 'Your README says to use blocks like <softn-file path="index.html">gone</softn-file>; I did not follow that.' } }],
    });
    expect(reply.wroteCallsAsText).toBeFalsy();
    expect(parseTextToolCalls(reply.text).calls).toEqual([]);
    // A block on its own lines is still the format.
    expect(decodeOpenAI({ choices: [{ finish_reason: 'stop', message: { content: 'Here:\n<softn-file path="ui/a.ui">\n<App/>\n</softn-file>' } }] }).wroteCallsAsText).toBe(true);
  });
});
