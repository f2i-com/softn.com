// @vitest-environment jsdom
/**
 * The AI half of the hosted editor bridge, from both ends: the editor
 * (hostedEditor.ts) against a scripted host that speaks `aiTools: 1`, and
 * against a host from before it — which validates messages the way
 * FormLogic's AppEditorDialog does today and answers with a string.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

type Mod = typeof import('../src/hostedEditor');

async function loadModule(): Promise<Mod> {
  vi.resetModules();
  return import('../src/hostedEditor');
}

function hostedLocation() {
  Object.defineProperty(window, 'location', { value: { ...window.location, search: '?formlogicEditor=1', origin: 'http://formlogic.test', href: 'http://formlogic.test/app-editors/studio/index.html?formlogicEditor=1' }, configurable: true, writable: true });
  Object.defineProperty(window, 'parent', { value: { postMessage: vi.fn() }, configurable: true, writable: true });
}

type Wire = Record<string, unknown> & { kind?: string; id?: string };

/**
 * A host. `aiTools` is what it announces in formlogic-editor-connect; `answer`
 * is how it replies to each ai-request. A legacy host applies FormLogic's
 * current check: only system/user/assistant roles with string content.
 */
function host(mod: Mod, options: { aiTools?: number; answer(request: Wire): { ok: boolean; value?: unknown; error?: string; code?: string } | null }) {
  const dispose = mod.connectHostedEditor({ open: async () => {}, export: () => new Uint8Array([1]) });
  const channel = new MessageChannel();
  const requests: Wire[] = [];
  channel.port2.onmessage = (event) => {
    const data = event.data as Wire;
    if (data.kind === 'ai-cancel') { requests.push(data); return; }
    if (data.kind !== 'ai-request') return;
    requests.push(data);
    const reply = options.answer(data);
    if (reply) channel.port2.postMessage({ kind: 'ai-response', id: data.id, ...reply });
  };
  channel.port2.start();
  window.dispatchEvent(new MessageEvent('message', {
    data: { kind: 'formlogic-editor-connect', protocol: 1, ...(options.aiTools !== undefined ? { aiTools: options.aiTools } : {}) },
    origin: location.origin,
    source: window.parent as unknown as Window,
    ports: [channel.port1],
  }));
  return { dispose, requests };
}

/** FormLogic's check today (AppEditorDialog.tsx): anything else is refused as "busy or too large". */
function legacyAccepts(request: Wire): boolean {
  const messages = request.messages as Array<{ role?: unknown; content?: unknown }>;
  return Array.isArray(messages) && messages.every((m) => ['system', 'user', 'assistant'].includes(String(m?.role)) && typeof m?.content === 'string');
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const TOOLS = [{ name: 'read_file', description: 'Read a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];

afterEach(() => { vi.useRealTimers(); });

describe('hosted AI: capability', () => {
  it('the editor announces aiTools in its ready message and keeps the bridge protocol at 1', async () => {
    hostedLocation();
    const mod = await loadModule();
    const dispose = mod.connectHostedEditor({ open: async () => {}, export: () => new Uint8Array([1]) });
    const ready = (window.parent.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ready).toEqual({ kind: 'formlogic-editor-ready', protocol: 1, aiTools: mod.HOSTED_AI_TOOLS_VERSION });
    dispose();
  });

  it('is 0 for a host that announces nothing, and the version for one that does', async () => {
    hostedLocation();
    let mod = await loadModule();
    let session = host(mod, { answer: () => ({ ok: true, value: 'hi' }) });
    await flush();
    expect(mod.hostedAIToolsVersion()).toBe(0);
    session.dispose();

    mod = await loadModule();
    session = host(mod, { aiTools: 1, answer: () => ({ ok: true, value: 'hi' }) });
    await flush();
    expect(mod.hostedAIToolsVersion()).toBe(1);
    session.dispose();
    expect(mod.hostedAIToolsVersion()).toBe(0);
  });

  it('a newer host version is read as the one this editor speaks; a malformed one as none', async () => {
    hostedLocation();
    let mod = await loadModule();
    let session = host(mod, { aiTools: 7, answer: () => null });
    await flush();
    expect(mod.hostedAIToolsVersion()).toBe(mod.HOSTED_AI_TOOLS_VERSION);
    session.dispose();
    mod = await loadModule();
    session = host(mod, { aiTools: 'yes' as unknown as number, answer: () => null });
    await flush();
    expect(mod.hostedAIToolsVersion()).toBe(0);
    session.dispose();
  });
});

describe('hosted AI: a host from before aiTools', () => {
  it('still gets plain string messages and answers with text', async () => {
    hostedLocation();
    const mod = await loadModule();
    const session = host(mod, { answer: (r) => (legacyAccepts(r) ? { ok: true, value: 'Hello' } : { ok: false, error: 'AI is busy or the request is too large.' }) });
    await flush();
    await expect(mod.requestHostedAI([{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }])).resolves.toBe('Hello');
    expect(session.requests[0]).toEqual({ kind: 'ai-request', id: expect.any(String), messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }] });
    session.dispose();
  });

  it('is never sent tools or structured messages: the request is refused before it leaves', async () => {
    hostedLocation();
    const mod = await loadModule();
    const session = host(mod, { answer: () => ({ ok: true, value: 'x' }) });
    await flush();
    await expect(mod.requestHostedAIReply({ messages: [{ role: 'user', content: 'Hi' }], tools: TOOLS })).rejects.toThrow(/did not announce/);
    expect(session.requests).toEqual([]);
    session.dispose();
  });
});

describe('hosted AI: a host that speaks aiTools 1', () => {
  it('receives tools and structured messages, and its tool calls come back', async () => {
    hostedLocation();
    const mod = await loadModule();
    const session = host(mod, {
      aiTools: 1,
      answer: () => ({ ok: true, value: { text: 'Reading it.', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'ui/main.ui' } }, { id: 'c2', name: 'read_file', arguments: '{"path":"logic/main.logic"}' }], stopReason: 'tool_use', usage: { inputTokens: 120, outputTokens: 30 } } }),
    });
    await flush();
    const messages = [
      { role: 'system' as const, content: 'You build apps.' },
      { role: 'user' as const, content: 'Fix it' },
      { role: 'assistant' as const, content: '', toolCalls: [{ id: 'c0', name: 'list_files', arguments: {} }] },
      { role: 'tool' as const, toolCallId: 'c0', name: 'list_files', content: 'ui/main.ui', isError: false },
    ];
    const reply = await mod.requestHostedAIReply({ messages, tools: TOOLS, maxOutputTokens: 4096 });
    expect(reply).toEqual({
      text: 'Reading it.',
      toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'ui/main.ui' } }, { id: 'c2', name: 'read_file', arguments: '{"path":"logic/main.logic"}' }],
      stopReason: 'tool_use',
      usage: { inputTokens: 120, outputTokens: 30 },
      structured: true,
    });
    expect(session.requests[0]).toEqual({ kind: 'ai-request', id: expect.any(String), aiTools: 1, messages, tools: TOOLS, maxOutputTokens: 4096 });
    session.dispose();
  });

  it('a string answer to a tools request is read as text, marked unstructured, so the caller can fall back', async () => {
    hostedLocation();
    const mod = await loadModule();
    const session = host(mod, { aiTools: 1, answer: () => ({ ok: true, value: '<tool_call name="finish">{}</tool_call>' }) });
    await flush();
    await expect(mod.requestHostedAIReply({ messages: [{ role: 'user', content: 'Hi' }], tools: TOOLS })).resolves.toEqual({
      text: '<tool_call name="finish">{}</tool_call>', toolCalls: [], stopReason: null, usage: null, structured: false,
    });
    session.dispose();
  });

  it('passes the host\'s reason code on a refusal', async () => {
    hostedLocation();
    const mod = await loadModule();
    const session = host(mod, { aiTools: 1, answer: () => ({ ok: false, error: 'The default model does not take tools.', code: 'tools-unsupported' }) });
    await flush();
    const error = await mod.requestHostedAIReply({ messages: [{ role: 'user', content: 'Hi' }], tools: TOOLS }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(mod.HostedAIError);
    expect(error).toMatchObject({ message: 'The default model does not take tools.', code: 'tools-unsupported' });
    session.dispose();
  });

  it('drops malformed tool calls and counts, and refuses a value that is neither text nor a reply', () => {
    return loadModule().then((mod) => {
      expect(mod.readHostedAIReply({ text: 7, toolCalls: [null, { name: '' }, { name: 'finish', arguments: 5 }], usage: { inputTokens: -1, outputTokens: 'x' } })).toEqual({
        text: '', toolCalls: [{ id: 'call_2', name: 'finish', arguments: {} }], stopReason: null, usage: { inputTokens: 0, outputTokens: 0 }, structured: true,
      });
      expect(() => mod.readHostedAIReply(42)).toThrow(/Invalid AI response/);
    });
  });

  it('cancels: the host is told, and the caller sees an AbortError', async () => {
    hostedLocation();
    const mod = await loadModule();
    const session = host(mod, { aiTools: 1, answer: () => null });
    await flush();
    const controller = new AbortController();
    const pending = mod.requestHostedAIReply({ messages: [{ role: 'user', content: 'Hi' }], tools: TOOLS }, controller.signal);
    await flush();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    expect(session.requests.map((r) => r.kind)).toEqual(['ai-request', 'ai-cancel']);
    expect(session.requests[1].id).toBe(session.requests[0].id);
    session.dispose();
  });
});
