// @vitest-environment jsdom
/**
 * The agent-run half of the hosted editor bridge (`agentRuns`): a host can
 * open a project with a brief for the editor's agent, and hears the agent's
 * status. Both halves are optional: an editor without an agent does not
 * announce it, and a host from before it never sends a brief nor hears a
 * status.
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
type Opened = { name: string; options: { brief: unknown } };

/** Connect an editor to a host that announces `agentRuns` (or not), and collect what the editor sends. */
function session(mod: Mod, options: { hostAgentRuns?: number; editorAgentRuns?: boolean }) {
  const opened: Opened[] = [];
  const dispose = mod.connectHostedEditor(
    { open: async (_bytes, name, openOptions) => { opened.push({ name, options: openOptions }); }, export: () => new Uint8Array([1]) },
    { agentRuns: options.editorAgentRuns ?? true },
  );
  const channel = new MessageChannel();
  const received: Wire[] = [];
  channel.port2.onmessage = (event) => { received.push(event.data as Wire); };
  channel.port2.start();
  window.dispatchEvent(new MessageEvent('message', {
    data: { kind: 'formlogic-editor-connect', protocol: 1, ...(options.hostAgentRuns !== undefined ? { agentRuns: options.hostAgentRuns } : {}) },
    origin: location.origin,
    source: window.parent as unknown as Window,
    ports: [channel.port1],
  }));
  const open = (extra: Record<string, unknown>) => channel.port2.postMessage({ id: 'open-1', method: 'open', bytes: new Uint8Array([80, 75]), name: 'Notes', ...extra });
  return { dispose, opened, received, open };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const statuses = (received: Wire[]) => received.filter((m) => m.kind === 'agent-status');

afterEach(() => { vi.useRealTimers(); });

describe('hosted agent runs: capability', () => {
  it('an editor with an agent announces agentRuns beside aiTools; one without does not', async () => {
    hostedLocation();
    let mod = await loadModule();
    let dispose = mod.connectHostedEditor({ open: async () => {}, export: () => new Uint8Array([1]) }, { agentRuns: true });
    expect((window.parent.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({ kind: 'formlogic-editor-ready', protocol: 1, aiTools: mod.HOSTED_AI_TOOLS_VERSION, agentRuns: mod.HOSTED_AGENT_RUNS_VERSION });
    dispose();

    hostedLocation();
    mod = await loadModule();
    dispose = mod.connectHostedEditor({ open: async () => {}, export: () => new Uint8Array([1]) });
    expect((window.parent.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({ kind: 'formlogic-editor-ready', protocol: 1, aiTools: mod.HOSTED_AI_TOOLS_VERSION });
    dispose();
  });

  it('is the host\'s version when it announces one, and 0 when it does not or the editor has no agent', async () => {
    hostedLocation();
    let mod = await loadModule();
    let s = session(mod, { hostAgentRuns: 1 });
    await flush();
    expect(mod.hostedAgentRunsVersion()).toBe(1);
    s.dispose();
    expect(mod.hostedAgentRunsVersion()).toBe(0);

    mod = await loadModule();
    s = session(mod, {});
    await flush();
    expect(mod.hostedAgentRunsVersion()).toBe(0);
    s.dispose();

    mod = await loadModule();
    s = session(mod, { hostAgentRuns: 1, editorAgentRuns: false });
    await flush();
    expect(mod.hostedAgentRunsVersion()).toBe(0);
    s.dispose();
  });
});

describe('hosted agent runs: the brief', () => {
  it('reaches the editor\'s open handler from a host that speaks agentRuns, trimmed and with its kind', async () => {
    hostedLocation();
    const mod = await loadModule();
    const s = session(mod, { hostAgentRuns: 1 });
    s.open({ brief: { prompt: '  Build a recipe box with favourites.  ', kind: 'build' } });
    await flush(); await flush();
    expect(s.opened).toEqual([{ name: 'Notes', options: { brief: { prompt: 'Build a recipe box with favourites.', kind: 'build' } } }]);
    s.dispose();
  });

  it('is ignored from a host that did not announce agentRuns', async () => {
    hostedLocation();
    const mod = await loadModule();
    const s = session(mod, {});
    s.open({ brief: { prompt: 'Build a recipe box.', kind: 'build' } });
    await flush(); await flush();
    expect(s.opened).toEqual([{ name: 'Notes', options: { brief: null } }]);
    s.dispose();
  });

  it('reads an empty or malformed brief as none, an unknown kind as build, and caps its length', () => {
    return loadModule().then((mod) => {
      expect(mod.readHostedBrief(undefined)).toBeNull();
      expect(mod.readHostedBrief({ prompt: '   ' })).toBeNull();
      expect(mod.readHostedBrief({ prompt: 42 })).toBeNull();
      expect(mod.readHostedBrief('Build it')).toBeNull();
      expect(mod.readHostedBrief({ prompt: 'Change the heading', kind: 'edit' })).toEqual({ prompt: 'Change the heading', kind: 'edit' });
      expect(mod.readHostedBrief({ prompt: 'Build it', kind: 'deploy' })).toEqual({ prompt: 'Build it', kind: 'build' });
      expect(mod.readHostedBrief({ prompt: 'x'.repeat(mod.HOSTED_BRIEF_MAX_CHARS + 50) })!.prompt).toHaveLength(mod.HOSTED_BRIEF_MAX_CHARS);
    });
  });
});

describe('hosted agent runs: status', () => {
  it('reaches a host that speaks agentRuns, once per change, with long text capped', async () => {
    hostedLocation();
    const mod = await loadModule();
    const s = session(mod, { hostAgentRuns: 1 });
    await flush();
    mod.reportHostedAgentStatus({ state: 'running', step: 'Thinking…' });
    mod.reportHostedAgentStatus({ state: 'running', step: 'Thinking…' });
    mod.reportHostedAgentStatus({ state: 'running', step: 'Checking the app…' });
    mod.reportHostedAgentStatus({ state: 'finished', summary: 's'.repeat(3000) });
    await flush();
    const sent = statuses(s.received);
    expect(sent.map((m) => [m.state, m.step])).toEqual([['running', 'Thinking…'], ['running', 'Checking the app…'], ['finished', undefined]]);
    expect(String(sent[2].summary)).toHaveLength(2000);
    s.dispose();
  });

  it('never reaches a host that did not announce agentRuns', async () => {
    hostedLocation();
    const mod = await loadModule();
    const s = session(mod, {});
    await flush();
    mod.reportHostedAgentStatus({ state: 'running', step: 'Thinking…' });
    await flush();
    expect(statuses(s.received)).toEqual([]);
    s.dispose();
  });
});
