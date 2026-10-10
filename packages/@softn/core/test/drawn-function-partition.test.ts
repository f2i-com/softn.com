/**
 * What following a drawn function costs, and what it must not cost.
 *
 * State the markup never names is kept in the engine and not mirrored to the
 * page. That is a speed-up with a particular app in mind: one whose large
 * state changes on every tick and is drawn by a canvas or a scene, not by
 * markup. Mirroring such state is what a tick costs; a list of four thousand
 * records, mirrored, took a tick from about 1 ms to about 45.
 *
 * What a function the page calls while it is drawn may read is mirrored too,
 * because the function is how the page reads it (drawn-function-state.test.tsx).
 * This holds the other side: the speed-up is still there for the app it
 * exists for. A function only an event runs widens nothing, a drawn function
 * widens by what it reads and no more, and where what it reads cannot be
 * told, everything is mirrored.
 *
 * Over the real engine, through the runtime a page is given.
 */
import { describe, it, expect } from 'vitest';
import { parse } from '../src/parser';
import {
  collectDrawnNames,
  collectObservedStateNames,
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type ScriptContext,
  type ScriptRuntimeOptions,
} from '../src/runtime/script-runtime';
import { logicEngineRunsPython } from '../src/runtime/vm-adapter';
import type { ScriptBlock } from '../src/parser/ast';

function makeContext(): ScriptContext {
  const state: Record<string, unknown> = {};
  return {
    state,
    setState: (path, value) => {
      state[path] = value;
    },
    batchSetState: (changes) => {
      Object.assign(state, changes);
    },
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
}

interface Held {
  /** The state mirrored to the page. */
  mirrored: string[];
  /** The state kept in the engine. */
  held: string[];
}

type Internals = { stateVarNames: string[]; vmOwnedStateNames: string[] };

/** Load a page's logic as the renderer does, and say which state is mirrored and which is held back. */
async function partition(source: string, options: { drawnNames?: 'omit' } = {}): Promise<Held> {
  const doc = parse(source);
  const runtime = createScriptRuntime(makeContext(), undefined, 'drawn-partition', undefined, undefined, {
    mode: 'main',
    observedStateNames: collectObservedStateNames(doc) ?? undefined,
    drawnNames: options.drawnNames === 'omit' ? undefined : (collectDrawnNames(doc) ?? undefined),
  });
  try {
    await runtime.loadScript(doc.logic!);
    const inner = runtime as unknown as Internals;
    return { mirrored: [...inner.stateVarNames].sort(), held: [...inner.vmOwnedStateNames].sort() };
  } finally {
    runtime.cleanup();
  }
}

// A game: a large list the logic moves on every tick, and a score.
const GAME = `
let entities = []
let score = 0
let frame = 0
let paused = false
for (let i = 0; i < 200; i++) entities.push({ x: i, y: i, vx: 1, vy: -1 })
function tick() {
  for (let i = 0; i < entities.length; i++) { entities[i].x = entities[i].x + entities[i].vx }
  frame = frame + 1
  if (frame % 10 === 0) score = score + 1
}
function start() { paused = false }
function scoreLabel() { return "Score: " + score }
function frameSource() { return entities.map((e) => e.x) }
function entityCount() { return entities.length }
`;

const page = (markup: string) => `<logic>${GAME}</logic>\n<div><button @click={() => start()}>Go</button><Loop @tick={tick} />${markup}</div>`;

describe('what is held back from the page', () => {
  it('is everything the markup does not name, when the page calls no function', async () => {
    const { mirrored, held } = await partition(page('<p>{score}</p>'));
    expect(mirrored).toEqual(['score']);
    expect(held).toEqual(['entities', 'frame', 'paused']);
  });

  // The shape the speed-up exists for: the score is shown through a function,
  // and the list stays where it is.
  it('still holds the large state back when the page shows the score through a function', async () => {
    const { mirrored, held } = await partition(page('<p>{scoreLabel()}</p>'));
    expect(mirrored).toEqual(['score']);
    expect(held).toEqual(['entities', 'frame', 'paused']);
  });

  it('is not widened by a function only an event runs', async () => {
    // `tick` and `start` read all of it, and neither is called to draw the page.
    for (const markup of ['', '<Loop onTick={tick} />', '<button @click={start}>a</button>', '<button @click={tick()}>b</button>']) {
      const { mirrored, held } = await partition(page(markup));
      expect(mirrored, markup).toEqual([]);
      expect(held, markup).toEqual(['entities', 'frame', 'paused', 'score']);
    }
  });

  // How Pocket and SoftDOS hand an emulator to a canvas and to the sound.
  // Followed, it mirrors the machine: every one of their 266 and 405
  // held-back names.
  it('is not widened by the function a canvas or an audio stream pulls from', async () => {
    for (const markup of [
      '<PixelCanvas getFrame={frameSource} />',
      '<AudioStream getSamples={frameSource} />',
      '<PixelCanvas getFrame={() => frameSource()} />',
    ]) {
      const { held } = await partition(page(markup));
      expect(held, markup).toEqual(['entities', 'frame', 'paused', 'score']);
    }
  });

  it('is widened by a function any other prop is handed by name', async () => {
    const { mirrored, held } = await partition(page('<Progress formatLabel={scoreLabel} />'));
    expect(mirrored).toEqual(['score']);
    expect(held).toEqual(['entities', 'frame', 'paused']);
  });

  it('is widened by exactly what a drawn function reads, when that is the large state', async () => {
    const { mirrored, held } = await partition(page('<p>{entityCount()}</p>'));
    expect(mirrored).toEqual(['entities']);
    expect(held).toEqual(['frame', 'paused', 'score']);
  });

  it('is not widened by the words of the page that are not expressions', async () => {
    // "tick" and "start" as words of a legend, a class and a style rule.
    const { held } = await partition(
      `<style>.tick { align-items: flex-start; }</style>\n${page('<p class="tick start">tick to start</p>')}`
    );
    expect(held).toContain('entities');
    expect(held).toContain('frame');
  });
});

describe('where what a drawn function reads cannot be told', () => {
  it('everything is mirrored', async () => {
    const { held, mirrored } = await partition(`<logic>
let secret = 1
let other = 2
let table = { a: function () { return secret } }
function lookup(kind) { return table[kind]() }
function label() { return lookup("a") }
function bump() { secret = secret + 1 }
</logic>
<div><button @click={() => bump()}>a</button><p>{label()}</p></div>`);
    expect(held).toEqual([]);
    expect(mirrored).toEqual(['other', 'secret', 'table']);
  });

  it('but not for a function no drawn function reaches', async () => {
    const { held } = await partition(`<logic>
let secret = 1
let shown = 2
let table = { a: function () { return secret } }
function dispatch(kind) { return table[kind]() }
function label() { return "x" + shown }
</logic>
<div><button @click={() => dispatch("a")}>a</button><p>{label()}</p></div>`);
    expect(held).toEqual(['secret', 'table']);
  });
});

describe('a host that says which names are observed and not which are drawn', () => {
  // Every observed name is then supposed to be drawn: correct, and it holds
  // less back, because an event's function counts.
  it('has every function the page names followed', async () => {
    const { mirrored } = await partition(page('<p>{score}</p>'), { drawnNames: 'omit' });
    expect(mirrored).toEqual(['entities', 'frame', 'paused', 'score']);
  });
});

describe.skipIf(!logicEngineRunsPython())('Python logic, which is not read for what a function reads', () => {
  const EMPTY_LOGIC: ScriptBlock = { type: 'ScriptBlock', code: '', loc: { line: 1, column: 0, start: 0, end: 0 } };
  const APP = ['tally = 1', 'other = 2', '', 'def bump():', '    global tally', '    tally = tally + 1', '', 'def label():', '    return "tally is " + str(tally)', ''].join('\n');

  async function pythonPartition(markup: string): Promise<Held> {
    const doc = parse(markup);
    const options: ScriptRuntimeOptions = {
      mode: 'main',
      pythonProject: { files: { app: APP }, modules: ['app'] },
      observedStateNames: collectObservedStateNames(doc) ?? undefined,
      drawnNames: collectDrawnNames(doc) ?? undefined,
    };
    const runtime = createScriptRuntime(makeContext(), undefined, 'drawn-partition-python', undefined, undefined, options);
    try {
      await runtime.loadScript(EMPTY_LOGIC);
      const inner = runtime as unknown as Internals;
      return { mirrored: [...inner.stateVarNames].sort(), held: [...inner.vmOwnedStateNames].sort() };
    } finally {
      runtime.cleanup();
    }
  }

  it('mirrors everything when the page calls a function while it is drawn', async () => {
    const { held, mirrored } = await pythonPartition('<div><button @click={() => bump()}>a</button><p>{label()}</p></div>');
    expect(held).toEqual([]);
    expect(mirrored).toContain('tally');
    expect(mirrored).toContain('other');
  });

  it('holds back what the markup does not name when the page calls none', async () => {
    const { held, mirrored } = await pythonPartition('<div><button @click={() => bump()}>a</button><p>{other}</p></div>');
    expect(mirrored).toContain('other');
    expect(held).toContain('tally');
  });
});
