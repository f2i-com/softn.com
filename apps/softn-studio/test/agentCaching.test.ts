/**
 * What a run's steps cost: the stable prefix marked for Anthropic's prompt
 * cache and kept byte-for-byte the same between compactions (which is also
 * what OpenAI's automatic prefix cache and a local server's KV cache need),
 * cache usage read from both APIs, streamed or not, and the budgets counted
 * in effective tokens. Compaction shortens superseded writes, old checks and
 * old reads in one go rather than a little every step.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { effectiveTokens, ANTHROPIC_CACHE_WEIGHTS } from '../src/lib/agent/budget';
import { startAgentRun } from '../src/lib/agent/runAgent';
import { useAIStore } from '../src/stores/aiStore';
import { assertScriptsPassed, fakeProvider, lastRun, OPENAI, resetAgent, say, seedApp, type Step } from './helpers/agentHarness';

beforeEach(() => resetAgent());
afterEach(() => {
  assertScriptsPassed();
  resetAgent();
});

/** Every object in a request that carries a cache breakpoint. */
function breakpoints(value: unknown, found: unknown[] = []): unknown[] {
  if (Array.isArray(value)) value.forEach((v) => breakpoints(v, found));
  else if (value && typeof value === 'object') {
    if ('cache_control' in value) found.push(value);
    Object.values(value).forEach((v) => breakpoints(v, found));
  }
  return found;
}

/** A request's messages as the cache sees them: the breakpoints are markers, not content. */
const content = (body: Record<string, unknown>) => JSON.stringify(body.messages, (key, value: unknown) => (key === 'cache_control' ? undefined : value));

const list = { calls: [{ name: 'list_files', input: {} }] };

describe('Anthropic prompt caching', () => {
  it('marks the tools, the system prompt and the conversation, and keeps the prefix the same from step to step', async () => {
    seedApp();
    const provider = fakeProvider('anthropic', [list, list, { calls: [{ name: 'read_file', input: { path: 'ui/main.ui' } }] }, { calls: [{ name: 'finish', input: { summary: 'ok' } }] }]);
    say('Look around');
    await startAgentRun();
    expect(lastRun().run.status).toBe('finished');

    for (const body of provider.bodies) {
      const system = body.system as Array<{ type: string; text: string; cache_control?: unknown }>;
      expect(system).toHaveLength(1);
      expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
      const tools = body.tools as Array<{ cache_control?: unknown }>;
      expect(tools.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
      expect(tools.slice(0, -1).some((t) => t.cache_control)).toBe(false);
      // Four at most, as the API allows: tools, system, the previous request's end, this one's end.
      expect(breakpoints(body).length).toBeLessThanOrEqual(4);
      const messages = body.messages as Array<{ role: string; content: Array<{ cache_control?: unknown }> }>;
      expect(messages.at(-1)?.content.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    }
    // The system prompt is the same bytes on every request; the project is in the first message instead.
    expect(new Set(provider.bodies.map((b) => JSON.stringify(b.system))).size).toBe(1);
    expect(JSON.stringify(provider.bodies[0].system)).not.toContain('## Project files');
    expect(JSON.stringify((provider.bodies[0].messages as unknown[])[0])).toContain('## Project files');
    // Each request is the last one with a step added: the last request's messages are a prefix of the next's.
    for (let i = 1; i < provider.bodies.length; i++) {
      const before = content(provider.bodies[i - 1]).slice(0, -1);
      expect(content(provider.bodies[i]).startsWith(before)).toBe(true);
    }
  });

  it('keeps the same system prompt for the next run in the project, so the cache carries over', async () => {
    seedApp();
    const provider = fakeProvider('anthropic', [{ calls: [{ name: 'finish', input: { summary: 'one' } }] }, { calls: [{ name: 'write_file', input: { path: 'ui/extra.ui', content: '<App><Text>x</Text></App>' } }] }, { calls: [{ name: 'finish', input: { summary: 'two' } }] }]);
    say('First');
    await startAgentRun();
    say('Second');
    await startAgentRun();
    expect(new Set(provider.bodies.map((b) => JSON.stringify(b.system))).size).toBe(1);
  });

  it('reads cache usage, shows it, and counts the budgets in effective tokens — streamed and not', async () => {
    seedApp();
    const steps: Step[] = [
      { ...list, usage: { input: 50, output: 20, cacheWrite: 10_000 } },
      { ...list, usage: { input: 60, output: 20, cacheRead: 10_000, cacheWrite: 200 } },
      { calls: [{ name: 'finish', input: { summary: 'ok' } }], usage: { input: 70, output: 20, cacheRead: 10_200 } },
    ];
    for (const stream of ['on', 'off'] as const) {
      resetAgent();
      seedApp();
      fakeProvider('anthropic', steps);
      if (stream === 'off') useAIStore.setState({ streamModes: { 'a:model-under-test': 'off' } });
      say('Look');
      await startAgentRun();
      const { run } = lastRun();
      expect(run.status).toBe('finished');
      const raw = 50 + 10_000 + 60 + 10_000 + 200 + 70 + 10_200;
      const effective = [
        { inputTokens: 10_050, outputTokens: 20, cacheWriteTokens: 10_000 },
        { inputTokens: 10_260, outputTokens: 20, cacheReadTokens: 10_000, cacheWriteTokens: 200 },
        { inputTokens: 10_270, outputTokens: 20, cacheReadTokens: 10_200 },
      ].reduce((sum, u) => sum + effectiveTokens(u, ANTHROPIC_CACHE_WEIGHTS), 0);
      expect(run.tokens).toEqual({ input: raw, output: 60, cached: 20_200, cacheWrite: 10_200, effective });
      // 12,500 for the first write, then about a tenth of each warm prefix: far under the raw count.
      expect(effective).toBeLessThan(raw / 2);
      expect(useAIStore.getState().tokensUsed).toBe(effective);
    }
  });

  it('lets a run go on while its effective tokens are under budget, though its raw count is not', async () => {
    seedApp();
    useAIStore.setState({ agentSettings: { ...useAIStore.getState().agentSettings, runTokenBudget: 60_000 } });
    const warm = { ...list, usage: { input: 100, output: 20, cacheRead: 20_000 } };
    fakeProvider('anthropic', [{ ...list, usage: { input: 100, output: 20, cacheWrite: 20_000 } }, warm, warm, warm, { calls: [{ name: 'finish', input: { summary: 'ok' } }], usage: { input: 100, output: 20, cacheRead: 20_000 } }]);
    say('Look');
    await startAgentRun();
    const { run } = lastRun();
    expect(run.status).toBe('finished');
    expect(run.tokens.input).toBeGreaterThan(60_000);
    expect(run.tokens.effective).toBeLessThan(60_000);
  });
});

describe('OpenAI-compatible prefix caching', () => {
  it('sends no breakpoints, keeps every request a prefix of the next, and reads cached_tokens', async () => {
    resetAgent(OPENAI);
    seedApp();
    const provider = fakeProvider('openai', [
      { ...list, usage: { input: 9_000, output: 10 } },
      { ...list, usage: { input: 500, output: 10, cacheRead: 9_000 } },
      { calls: [{ name: 'finish', input: { summary: 'ok' } }], usage: { input: 400, output: 10, cacheRead: 9_500 } },
    ]);
    say('Look');
    await startAgentRun();
    const { run } = lastRun();
    expect(run.status).toBe('finished');
    expect(breakpoints(provider.bodies)).toEqual([]);
    for (let i = 1; i < provider.bodies.length; i++) {
      expect(JSON.stringify(provider.bodies[i].messages).startsWith(JSON.stringify(provider.bodies[i - 1].messages).slice(0, -1))).toBe(true);
    }
    expect(run.tokens).toMatchObject({ input: 9_000 + 9_500 + 9_900, cached: 18_500 });
    expect(run.tokens.effective).toBe(9_000 + 500 + 4_500 + 400 + 4_750 + 30);
  });
});

describe('compaction', () => {
  const big = (v: string) => `<logic src="../logic/main.logic" />\n\n<App>\n${Array.from({ length: 40 }, (_, i) => `  <Text>{count} ${v} line ${i}</Text>`).join('\n')}\n</App>`;

  it('keeps the conversation append-only between compactions, then shortens superseded writes and old checks together', async () => {
    seedApp();
    const write = (v: string) => ({ calls: [{ name: 'write_file', input: { path: 'ui/week.ui', content: big(v) } }] });
    const script = [
      write('first'),
      { calls: [{ name: 'read_file', input: { path: 'ui/week.ui' } }] },
      write('second'),
      ...Array.from({ length: 6 }, () => list),
      (body: Record<string, unknown>) => {
        const sent = JSON.stringify(body.messages);
        // The first version is a one-line record now; the latest is whole.
        expect(sent).toMatch(/\[44 lines written at step 1; the file has been changed since — read_file shows it now\]/);
        expect(sent).not.toContain('first line 39');
        expect(sent).toContain('second line 39');
        // The read of a file changed since, and the older check, are shortened too; the latest check is not.
        expect(sent).toMatch(/\[read_file result from step 2, \d+ lines; ui\/week\.ui has been changed since\./);
        expect(sent.match(/\[Automatic check: superseded by a later check\.\]/g)).toHaveLength(1);
        expect(sent.match(/\[Automatic check\] Check passed/g)).toHaveLength(1);
        return { calls: [{ name: 'finish', input: { summary: 'ok' } }] };
      },
    ];
    const provider = fakeProvider('anthropic', script);
    say('Rewrite it twice');
    await startAgentRun();
    expect(lastRun().run.status).toBe('finished');
    // Until the compaction after step 8, every request extends the one before it; that one rewrites the past, once.
    for (let i = 1; i < 8; i++) expect(content(provider.bodies[i]).startsWith(content(provider.bodies[i - 1]).slice(0, -1))).toBe(true);
    expect(content(provider.bodies[8]).startsWith(content(provider.bodies[7]).slice(0, -1))).toBe(false);
    expect(content(provider.bodies[9]).startsWith(content(provider.bodies[8]).slice(0, -1))).toBe(true);
  });
});
