/**
 * Events told to an app's script while it is still answering earlier ones (worker isolation).
 *
 * The page merges the person's moves while the script is busy: only the latest move of a kind
 * waits, and is told once the script has answered. What is not a move is told as it happens.
 * These run the real mount with a stand-in Worker that answers when the test says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountSoftNContainer, type SoftNContainerHandle } from '../src/index';

type Posted = { type: string; [key: string]: unknown };

class FakeWorker {
  static all: FakeWorker[] = [];
  readonly posted: Posted[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<(ev: unknown) => void>>();

  constructor(readonly url: string) {
    FakeWorker.all.push(this);
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }

  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  postMessage(msg: Posted): void {
    this.posted.push(msg);
    if (msg.type === 'init') queueMicrotask(() => this.emit({ type: 'ready' }));
  }

  emit(data: unknown): void {
    for (const fn of [...(this.listeners.get('message') ?? [])]) fn({ data });
  }

  terminate(): void {
    this.terminated = true;
  }

  /** The events told to the script, in the order they were told. */
  events(): Array<{ turnId: number; nodeId: number; eventType: string; props: Record<string, unknown>; syncChanges: unknown[] }> {
    return this.posted.filter((m) => m.type === 'event') as never;
  }

  /** The script's answer to a turn, drawing nothing. */
  answer(turnId: number): void {
    this.emit({ type: 'ops', ops: [], turnId, eventBits: 0 });
  }
}

const EMPTY_WASM = new WebAssembly.Module(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));

const PAGE = `<!doctype html><html><body>
  <div id="a">A</div><div id="b">B</div><div id="c">C</div><div id="d">D</div>
  <div id="list" style="height:40px;overflow:auto"><div style="height:400px">rows</div></div>
  <script>void 0</script></body></html>`;

let handle: SoftNContainerHandle | null = null;

async function mountWithFakeWorker(listen: string[]) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  handle = await mountSoftNContainer(host, {
    isolation: 'worker',
    engineWasm: { lite: EMPTY_WASM, javascript: EMPTY_WASM, typescript: EMPTY_WASM },
    permissionMode: 'deny',
    persistStorage: false,
    source: { 'index.html': PAGE },
  });
  const worker = FakeWorker.all[FakeWorker.all.length - 1];
  worker.emit({ type: 'ops', ops: listen.map((type) => ['l', type]) });
  const el = (id: string) => handle!.shadowRoot.getElementById(id) as HTMLElement;
  const idOf = (id: string) => Number(el(id).getAttribute('data-softn-id'));
  return { worker, el, idOf };
}

beforeEach(() => {
  FakeWorker.all = [];
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  handle?.dispose();
  handle = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('events told while the script is busy', () => {
  it('tells every element its own mouseleave (and mouseout), never one element in place of another', async () => {
    const { worker, el, idOf } = await mountWithFakeWorker(['mouseleave', 'mouseout']);
    // The pointer crosses A, B, C and D quickly while the script answers the first.
    for (const id of ['a', 'b', 'c']) {
      el(id).dispatchEvent(new MouseEvent('mouseout', { bubbles: true, clientX: 5, clientY: 5 }));
      el(id).dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, clientX: 5, clientY: 5 }));
    }
    for (const ev of worker.events()) worker.answer(ev.turnId);
    for (const ev of worker.events()) worker.answer(ev.turnId);
    const told = worker.events().map((ev) => `${ev.eventType}:${ev.nodeId}`);
    expect(told).toEqual([
      `mouseout:${idOf('a')}`, `mouseleave:${idOf('a')}`,
      `mouseout:${idOf('b')}`, `mouseleave:${idOf('b')}`,
      `mouseout:${idOf('c')}`, `mouseleave:${idOf('c')}`,
    ]);
  });

  it('tells a waiting mousemove or touchmove before the press, release or touchend that came after it', async () => {
    const { worker, el, idOf } = await mountWithFakeWorker(['mousemove', 'mouseup', 'touchmove', 'touchend']);
    el('a').dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 1, clientY: 1 }));
    // The script is busy with that move; the next waits, and the release comes after it.
    el('a').dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 9, clientY: 9 }));
    el('a').dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 9, clientY: 9 }));
    const order = worker.events().map((ev) => `${ev.eventType}@${String(ev.props.clientX)}`);
    expect(order).toEqual(['mousemove@1', 'mousemove@9', 'mouseup@9']);

    // A touch: its last move is told before its end.
    const touchStart = worker.events().length;
    const touch = (type: string) => {
      const ev = new Event(type, { bubbles: true });
      el('b').dispatchEvent(ev);
    };
    touch('touchmove');
    touch('touchmove');
    touch('touchend');
    const touches = worker.events().slice(touchStart).map((ev) => `${ev.eventType}:${ev.nodeId}`);
    expect(touches).toEqual([`touchmove:${idOf('b')}`, `touchmove:${idOf('b')}`, `touchend:${idOf('b')}`]);
  });

  it('merges the waiting moves of each pointer apart, so one finger never stands in for another', async () => {
    const { worker, el } = await mountWithFakeWorker(['pointermove']);
    const move = (pointerId: number, x: number) => {
      const ev = new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: 0 });
      Object.defineProperty(ev, 'pointerId', { value: pointerId });
      Object.defineProperty(ev, 'pointerType', { value: 'touch' });
      el('a').dispatchEvent(ev);
    };
    move(1, 10);
    move(2, 20);
    move(1, 11);
    move(2, 21);
    move(1, 12);
    // Each finger's first move went at once; each finger's latest waits, and none was lost.
    for (const ev of worker.events()) worker.answer(ev.turnId);
    const told = worker.events().map((ev) => `${String(ev.props.pointerId)}@${String(ev.props.clientX)}`);
    expect(told).toEqual(['1@10', '2@20', '1@12', '2@21']);
  });

  it('tells how far the pointer moved in all (movementX/Y) when waiting moves are merged, as a mouse look reads it', async () => {
    const { worker, el } = await mountWithFakeWorker(['mousemove']);
    const move = (dx: number, dy: number) => {
      const ev = new MouseEvent('mousemove', { bubbles: true, clientX: 50, clientY: 50 });
      Object.defineProperty(ev, 'movementX', { value: dx });
      Object.defineProperty(ev, 'movementY', { value: dy });
      el('a').dispatchEvent(ev);
    };
    move(1, 1);
    // While the script turns the camera for that one, the person keeps moving the mouse.
    move(4, -2);
    move(3, 5);
    move(2, 0);
    worker.answer(worker.events()[0].turnId);
    const told = worker.events().map((ev) => [ev.props.movementX, ev.props.movementY]);
    expect(told).toEqual([[1, 1], [9, 3]]);
  });

  it('keeps where the person scrolled to when a waiting move is merged into a later one', async () => {
    const { worker, el, idOf } = await mountWithFakeWorker(['mousemove']);
    el('a').dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 1, clientY: 1 }));
    // The person scrolls the list; the next move carries where it is now.
    const list = el('list');
    list.scrollTop = 120;
    list.dispatchEvent(new Event('scroll'));
    el('a').dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 2, clientY: 2 }));
    // A later move takes the waiting one's place: what the earlier one carried is not lost.
    el('a').dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 3, clientY: 3 }));
    worker.answer(worker.events()[0].turnId);
    const told = worker.events();
    expect(told.map((ev) => ev.props.clientX)).toEqual([1, 3]);
    const scrolls = told[1].syncChanges.filter((c) => Array.isArray(c) && c[0] === 'Y');
    expect(scrolls).toEqual([['Y', idOf('list'), 120, 0]]);
  });
});
