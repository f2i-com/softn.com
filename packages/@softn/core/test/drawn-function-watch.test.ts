/**
 * State only a drawn function reads is watched, not copied.
 *
 * A function the page calls while it is drawn is how the page reads state its
 * markup does not name (drawn-function-state.test.tsx), so a change to that
 * state has to draw the page again. It did, by copying the state out of the
 * engine after every call and comparing it with the last copy: for a list of
 * four thousand records that one function counts, about 35 ms of every tick
 * of a game loop, to hand the page a value it never reads. The function
 * reads the engine's own, when the page is drawn.
 *
 * What the page needs is to be told the state moved. The engine digests it
 * in place without copying it (the digests the mirrored state already uses),
 * so such state is watched: a digest that moved draws the page again, and
 * the value stays where it is. Nothing is pushed back either, since the page
 * holds no copy of its own to push.
 *
 * Over the real engine, through the runtime a page is given.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { parse } from '../src/parser';
import {
  collectDrawnNames,
  collectObservedStateNames,
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type ScriptContext,
  type ScriptLoadResult,
  type ScriptRuntimeHandle,
} from '../src/runtime/script-runtime';

const GAME = `
let entities = []
let score = 0
let frame = 0
for (let i = 0; i < 200; i++) entities.push({ x: i, vx: 1 })
function tick() {
  for (let i = 0; i < entities.length; i++) entities[i].x = entities[i].x + entities[i].vx
  frame = frame + 1
  if (frame % 10 === 0) score = score + 1
}
function rest() {}
function lead() { return "lead at " + entities[0].x }
`;

const runtimes: ScriptRuntimeHandle[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.cleanup();
});

interface Page {
  loaded: ScriptLoadResult;
  state: Record<string, unknown>;
  /** Every time the page was told to draw again, with what it was handed. */
  draws: Array<Record<string, unknown>>;
  /** The slots read out of the engine, each read. */
  reads: number[][];
  index: (name: string) => number;
  /** Whether the engine digests state in place; the host-JavaScript engine does not. */
  digests: boolean;
}

async function load(markup: string, options: { redraw?: boolean } = {}): Promise<Page> {
  const doc = parse(`<logic>${GAME}</logic>\n${markup}`);
  const state: Record<string, unknown> = {};
  const draws: Array<Record<string, unknown>> = [];
  const context: ScriptContext = {
    state,
    setState: (path, value) => {
      state[path] = value;
      draws.push({ [path]: value });
    },
    batchSetState: (changes) => {
      Object.assign(state, changes);
      draws.push({ ...changes });
    },
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
  if (options.redraw !== false) context.redraw = () => draws.push({});
  const runtime = createScriptRuntime(context, undefined, 'drawn-watch', undefined, undefined, {
    mode: 'main',
    observedStateNames: collectObservedStateNames(doc) ?? undefined,
    drawnNames: collectDrawnNames(doc) ?? undefined,
  });
  runtimes.push(runtime);
  const loaded = await runtime.loadScript(doc.logic!);
  Object.assign(state, loaded.state);
  const inner = runtime as unknown as {
    vmEngine: {
      getGlobalsBatch: (indices: number[]) => unknown[];
      getGlobalsFingerprint?: (indices: number[]) => number[] | null;
    };
    symbolMap: Map<string, { index: number }>;
  };
  const reads: number[][] = [];
  const engine = inner.vmEngine;
  const read = engine.getGlobalsBatch.bind(engine);
  engine.getGlobalsBatch = (indices: number[]) => {
    reads.push([...indices]);
    return read(indices);
  };
  const digests = Array.isArray(engine.getGlobalsFingerprint?.([]));
  return { loaded, state, draws, reads, index: (name) => inner.symbolMap.get(name)!.index, digests };
}

describe('state only a drawn function reads', () => {
  it('draws the page again when it moves, without being read out of the engine', async () => {
    const page = await load('<div><Loop @tick={tick} /><p>{lead()}</p></div>');
    expect(page.loaded.syncFunctions.lead()).toBe('lead at 0');

    for (let i = 0; i < 5; i++) await page.loaded.functions.tick();

    expect(page.draws.length).toBe(5);
    expect(page.loaded.syncFunctions.lead()).toBe('lead at 5');
    const entities = page.index('entities');
    // An engine that cannot digest in place has it copied, as before.
    expect(page.reads.some((indices) => indices.includes(entities))).toBe(!page.digests);
  });

  it('does not draw the page when it has not moved', async () => {
    const page = await load('<div><button @click={() => rest()}>a</button><p>{lead()}</p></div>');
    await page.loaded.functions.tick();
    const drawn = page.draws.length;
    await page.loaded.functions.rest();
    await page.loaded.functions.rest();
    expect(page.draws.length).toBe(drawn);
  });

  it('is still copied where the markup names it as well', async () => {
    const page = await load('<div><Loop @tick={tick} /><p>{lead()}</p><p>{entities.length}</p></div>');
    await page.loaded.functions.tick();
    expect((page.state.entities as Array<{ x: number }>)[0].x).toBe(1);
  });

  it('is still copied for a host that cannot be asked to draw the page again', async () => {
    const page = await load('<div><Loop @tick={tick} /><p>{lead()}</p></div>', { redraw: false });
    await page.loaded.functions.tick();
    expect((page.state.entities as Array<{ x: number }>)[0].x).toBe(1);
    expect(page.loaded.syncFunctions.lead()).toBe('lead at 1');
  });
});
