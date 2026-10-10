/**
 * The worker makes the same partition the main thread does.
 *
 * A page that calls a function while it is drawn is never run in the worker:
 * a call needs its answer before the next line, and the worker's functions
 * answer with promises (SoftNRenderer keeps such a page on the main thread;
 * see `templateRequiresSyncCalls`). What can reach the worker is a page that
 * names a function without calling it, `columns={[{ render: cell }]}`. What
 * that function may read is observed there as it is on the main thread, by
 * the same reading of the logic (drawn-functions.ts), so the two threads
 * cannot hold back different state for one page.
 *
 * jsdom has no Worker, so this drives the worker's own script: the module is
 * loaded here, with `self.postMessage` caught, and sent the messages the
 * runtime would send it. The engine in it is the real one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from '../src/parser';
import { collectDrawnNames, collectObservedStateNames } from '../src/runtime/script-runtime';

type Reply = { id: number; ok: boolean; result?: Record<string, unknown>; error?: string };

const scope = self as unknown as {
  postMessage: (message: unknown) => void;
  onmessage: ((event: { data: unknown }) => unknown) | null;
};
const realPostMessage = scope.postMessage;
const replies: Reply[] = [];
let nextId = 1;

async function send(type: string, payload: Record<string, unknown>): Promise<Reply> {
  const id = nextId++;
  await scope.onmessage!({ data: { id, type, payload } });
  const reply = replies.find((candidate) => candidate.id === id);
  expect(reply, `the worker should answer ${type}`).toBeDefined();
  expect(reply!.error).toBeUndefined();
  return reply!;
}

/** Hand the worker a page's logic as the worker runtime does, and answer the state it mirrors. */
async function init(source: string, options: { drawnNames?: 'omit' } = {}): Promise<string[]> {
  const doc = parse(source);
  const observed = collectObservedStateNames(doc);
  const drawn = collectDrawnNames(doc);
  // A worker is given one script in its life; here it is given several, so
  // what it kept of the last one is let go first.
  await send('dispose', {});
  const reply = await send('init', {
    script: doc.logic,
    observedStateNames: observed ? [...observed] : null,
    drawnNames: options.drawnNames === 'omit' || !drawn ? null : [...drawn],
    preIncludedLogicPaths: [],
    externalPreamble: '',
  });
  return Object.keys(reply.result!.state as Record<string, unknown>).sort();
}

beforeAll(async () => {
  scope.postMessage = (message: unknown) => {
    replies.push(message as Reply);
  };
  await import('../src/runtime/script-worker');
});

afterAll(async () => {
  await send('dispose', {});
  scope.postMessage = realPostMessage;
  scope.onmessage = null;
});

const LOGIC = `<logic>
let rows = ["tea", "bun"]
let unit = "kg"
let entities = [1, 2, 3]
let frame = 0
function tick() { frame = frame + entities.length }
function bump() { unit = unit + "!" }
function cell(row) { return row + " " + unit }
function frameSource() { return entities }
</logic>`;

describe('the state the worker mirrors', () => {
  it('includes what a function the page names for drawing reads, and not what an event reads', async () => {
    const mirrored = await init(`${LOGIC}
<div>
  <button @click={() => bump()}>a</button>
  <Loop @tick={tick} />
  <Table rows={rows} columns={[{ render: cell }]} />
</div>`);
    expect(mirrored).toEqual(['rows', 'unit']);

    // And a change to it comes back from the call that made it.
    const reply = await send('call_fn', { name: 'bump', args: [] });
    expect(reply.result!.state).toEqual({ unit: 'kg!' });
  });

  it('is only what the markup names when the page names no function for drawing', async () => {
    const mirrored = await init(`${LOGIC}
<div>
  <button @click={() => bump()}>a</button>
  <Loop @tick={tick} />
  <PixelCanvas getFrame={frameSource} />
  <p>{rows.length}</p>
</div>`);
    expect(mirrored).toEqual(['rows']);
  });

  it('is everything where what the function reads cannot be told', async () => {
    const mirrored = await init(`<logic>
let secret = 1
let other = 2
let table = { a: function () { return secret } }
function lookup(kind) { return table[kind]() }
function cell(row) { return lookup("a") }
</logic>
<div><Table columns={[{ render: cell }]} /></div>`);
    expect(mirrored).toEqual(['other', 'secret', 'table']);
  });

  it('supposes every observed function is drawn when it is not told which are', async () => {
    const mirrored = await init(
      `${LOGIC}
<div><Loop @tick={tick} /><p>{rows.length}</p></div>`,
      { drawnNames: 'omit' }
    );
    expect(mirrored).toEqual(['entities', 'frame', 'rows']);
  });
});
