/**
 * The agent inside the hosted editor: native tool calls over the bridge when
 * the host announced `aiTools`, text tool calls when it did not, and the fall
 * back to text when a host that announced them answers without them. The
 * bridge (editor-shared) is replaced by a scripted host; the loop, the tools
 * and the VFS are real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostedAIReply, HostedAIRequest } from '@softn/editor-shared/hostedEditor';

const host = vi.hoisted(() => ({
  version: 1,
  structured: [] as Array<HostedAIRequest>,
  plain: [] as Array<Array<{ role: string; content: string }>>,
  replies: [] as Array<unknown>,
}));

vi.mock('@softn/editor-shared/hostedEditor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@softn/editor-shared/hostedEditor')>();
  const next = () => {
    const reply = host.replies.shift();
    if (reply === undefined) throw new Error('The scripted host has no reply left.');
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return {
    ...actual,
    isHostedEditor: () => true,
    hostedAIToolsVersion: () => host.version,
    requestHostedAI: async (messages: Array<{ role: string; content: string }>) => {
      host.plain.push(messages);
      const reply = next();
      if (typeof reply !== 'string') throw new Error('Invalid AI response.');
      return reply;
    },
    requestHostedAIReply: async (request: HostedAIRequest): Promise<HostedAIReply> => {
      if (host.version < 1) throw new Error('FormLogic did not announce AI tool calls.');
      host.structured.push(JSON.parse(JSON.stringify(request)) as HostedAIRequest);
      return actual.readHostedAIReply(next());
    },
  };
});

const { HostedAIError } = await import('@softn/editor-shared/hostedEditor');
const { startAgentRun } = await import('../src/lib/agent/runAgent');
const { useAIStore } = await import('../src/stores/aiStore');
const { assertScriptsPassed, lastRun, resetAgent, say, seedApp, text } = await import('./helpers/agentHarness');

const FORMLOGIC = { id: 'formlogic', type: 'custom' as const, name: 'FormLogic AI', apiKey: '', modelId: 'host-default' };

beforeEach(() => {
  resetAgent(FORMLOGIC);
  seedApp();
  host.version = 1;
  host.structured = [];
  host.plain = [];
  host.replies = [];
});
afterEach(() => {
  assertScriptsPassed();
  expect(host.replies).toEqual([]);
});

describe('the hosted editor with a host that announced aiTools', () => {
  it('sends the tools and a structured conversation, runs the calls it gets back, and never streams', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    host.replies = [
      { text: 'Reading the page.', toolCalls: [{ id: 'h1', name: 'read_file', arguments: { path: 'ui/main.ui' } }], stopReason: 'tool_use', usage: { inputTokens: 500, outputTokens: 20 } },
      { text: '', toolCalls: [{ id: 'h2', name: 'edit_file', arguments: '{"path":"ui/main.ui","old_string":"<Heading level={1}>Tasks</Heading>","new_string":"<Heading level={1}>Chores</Heading>"}' }], stopReason: 'tool_use', usage: { inputTokens: 600, outputTokens: 30 } },
      { text: '', toolCalls: [{ id: 'h3', name: 'finish', arguments: { summary: 'Renamed the heading.' } }], stopReason: 'tool_use', usage: { inputTokens: 700, outputTokens: 10 } },
    ];
    say('Call it Chores');
    await startAgentRun();
    const { run } = lastRun();
    expect(run.status).toBe('finished');
    expect(run.protocol).toBe('hosted');
    expect(text('ui/main.ui')).toContain('<Heading level={1}>Chores</Heading>');
    expect(run.tokens).toEqual({ input: 1800, output: 60, effective: 1860 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(host.plain).toEqual([]);

    const first = host.structured[0];
    expect(first.tools?.map((t) => t.name)).toContain('edit_file');
    expect(first.tools?.[0]).toEqual({ name: expect.any(String), description: expect.any(String), inputSchema: expect.objectContaining({ type: 'object' }) });
    expect(first.messages[0]).toMatchObject({ role: 'system' });
    // The native system prompt: no text-protocol instructions.
    expect(first.messages[0].content).not.toContain('<tool_call');
    const third = host.structured[2].messages;
    expect(third.slice(-4)).toEqual([
      { role: 'assistant', content: 'Reading the page.', toolCalls: [{ id: 'h1', name: 'read_file', arguments: { path: 'ui/main.ui' } }] },
      { role: 'tool', toolCallId: 'h1', name: 'read_file', content: expect.stringContaining('Tasks') },
      { role: 'assistant', content: '', toolCalls: [{ id: 'h2', name: 'edit_file', arguments: expect.objectContaining({ path: 'ui/main.ui' }) }] },
      { role: 'tool', toolCallId: 'h2', name: 'edit_file', content: expect.stringContaining('[Automatic check]') },
    ]);
  });

  it('falls back to text tool calls when the host answers a tools request with a plain string, and remembers it', async () => {
    host.replies = [
      'I cannot call tools here.',
      '<tool_call name="finish">{"summary":"Done in text."}</tool_call>',
    ];
    say('Do it');
    await startAgentRun();
    const { run } = lastRun();
    expect(run.status).toBe('finished');
    expect(run.summary).toBe('Done in text.');
    expect(run.protocol).toBe('text');
    expect(host.structured).toHaveLength(1);
    // The retry is the plain form every host takes, with the text protocol in the prompt.
    expect(host.plain).toHaveLength(1);
    expect(host.plain[0].every((m) => typeof m.content === 'string' && ['system', 'user', 'assistant'].includes(m.role))).toBe(true);
    expect(host.plain[0][0].content).toContain('<tool_call name=');
    expect(useAIStore.getState().toolProtocols['formlogic:host-default']).toBe('text');
  });

  it('falls back the same way when the host refuses with tools-unsupported', async () => {
    host.replies = [new HostedAIError('Your AI provider cannot call tools.', 'tools-unsupported'), '<tool_call name="finish">{"summary":"ok"}</tool_call>'];
    say('Do it');
    await startAgentRun();
    expect(lastRun().run.status).toBe('finished');
    expect(lastRun().run.protocol).toBe('text');
  });
});

describe('the hosted editor with a host from before aiTools', () => {
  it('uses the text protocol over plain messages from the start', async () => {
    host.version = 0;
    host.replies = ['<tool_call name="read_file">{"path":"ui/main.ui"}</tool_call>', '<tool_call name="finish">{"summary":"Looked."}</tool_call>'];
    say('Look at it');
    await startAgentRun();
    const { run } = lastRun();
    expect(run.status).toBe('finished');
    expect(run.protocol).toBe('text');
    expect(host.structured).toEqual([]);
    expect(host.plain).toHaveLength(2);
    expect(host.plain[1].at(-1)?.content).toContain('<tool_result name="read_file" status="ok">');
  });
});
