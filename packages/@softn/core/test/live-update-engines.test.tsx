/**
 * An open app handed a newer version of itself, on the engines beside the
 * main thread's: a script in a worker of its own, and logic written in
 * Python. (The main-thread engine is in live-update.test.tsx.)
 *
 * A worker takes everything the main thread takes: new markup where it
 * stands, new logic with its variables carried over. A Python app takes new
 * markup where it stands; its logic is started again clean when it changes,
 * because its engine has no way to look through its variables, and the
 * answer says so.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { logicEngineRunsPython } from '../src/runtime/vm-adapter';
import { withInProcessWorker } from './helpers/in-process-worker';
import { drawLivePage, type LivePage } from './helpers/live-page';

let page: LivePage | null = null;
let apps = 0;

afterEach(async () => {
  await page?.unmount();
  page = null;
  localStorage.clear();
});

const logic = (body: string) => `<logic>\n${body}\n</logic>\n`;

const COUNTER = `
let count = 0
let secret = 0
let inits = 0
function _init() { inits = inits + 1 }
function inc() { count = count + 1; secret = secret + 10 }
`;

const PAGE = `<div>
  <button id="inc" @click={inc}>Add</button>
  <span class="count">{count}</span>
  <span class="inits">{inits}</span>
</div>`;

describe('an open app whose script runs in a worker', () => {
  async function counter(): Promise<LivePage> {
    page = await drawLivePage({ source: logic(COUNTER) + PAGE, appId: `live-worker-${++apps}`, executionPreference: 'worker' });
    await page.reads('.inits', '1');
    await page.click('#inc');
    await page.click('#inc');
    await page.reads('.count', '2');
    return page;
  }

  it('takes new markup where it stands, and a variable the page begins to read', () =>
    withInProcessWorker(async () => {
      const app = await counter();
      await app.set({
        source: logic(COUNTER) + PAGE.replace('Add', 'Add one').replace('</div>', '  <span class="secret">{secret}</span>\n</div>'),
      });
      expect(await app.answer()).toEqual({ outcome: 'updated', changed: ['page'] });
      expect(app.text('#inc')).toBe('Add one');
      await app.reads('.secret', '20');
      expect(app.text('.count')).toBe('2');
      expect(app.text('.inits')).toBe('1');
      await app.click('#inc');
      await app.reads('.count', '3');
      await app.reads('.secret', '30');
    }), 60_000);

  it('starts new logic with its variables carried over', () =>
    withInProcessWorker(async () => {
      const app = await counter();
      await app.set({ source: logic(COUNTER.replace('count = count + 1', 'count = count + 5')) + PAGE });
      const answer = await app.answer();
      expect(answer).toMatchObject({ outcome: 'restarted', changed: ['logic'], carried: true });
      await app.reads('.count', '2');
      await app.reads('.inits', '2');
      await app.click('#inc');
      await app.reads('.count', '7');
    }), 60_000);

  it('starts clean, and says why, when a variable cannot be carried', () =>
    withInProcessWorker(async () => {
      const body = COUNTER + 'let grid = new Uint8Array(4)\n';
      page = await drawLivePage({ source: logic(body) + PAGE, appId: `live-worker-${++apps}`, executionPreference: 'worker' });
      await page.reads('.inits', '1');
      await page.click('#inc');
      await page.reads('.count', '1');
      await page.set({ source: logic(body.replace('secret + 10', 'secret + 20')) + PAGE });
      const answer = await page.answer();
      expect(answer).toMatchObject({ outcome: 'restarted', carried: false });
      expect(answer.reason).toContain('`grid`');
      await page.reads('.count', '0');
    }), 60_000);

  it('keeps the logic that is running when the new logic does not parse', () =>
    withInProcessWorker(async () => {
      const app = await counter();
      await app.set({ source: logic(COUNTER + '\nfunction half( {') + PAGE });
      expect((await app.answer()).outcome).toBe('kept');
      await app.click('#inc');
      await app.reads('.count', '3');
      expect(app.text('.inits')).toBe('1');
    }), 60_000);
});

describe.skipIf(!logicEngineRunsPython())('an open app whose logic is Python', () => {
  const EMPTY = '<logic>\n</logic>\n';
  const python = (step: number) => ({
    files: {
      app: [
        'count = 0',
        'inits = 0',
        '',
        'def _init():',
        '    global inits',
        '    inits = inits + 1',
        '',
        'def inc(event=None):',
        '    global count',
        `    count = count + ${step}`,
        '',
      ].join('\n'),
    },
    modules: ['app'],
  });

  async function counter(): Promise<LivePage> {
    page = await drawLivePage({ source: EMPTY + PAGE, python: python(1), appId: `live-python-${++apps}`, scriptExecutionMode: 'main' });
    await page.reads('.inits', '1');
    await page.click('#inc');
    await page.click('#inc');
    await page.reads('.count', '2');
    return page;
  }

  it('takes new markup where it stands', async () => {
    const app = await counter();
    await app.set({ source: EMPTY + PAGE.replace('Add', 'Add one') });
    expect(await app.answer()).toEqual({ outcome: 'updated', changed: ['page'] });
    expect(app.text('#inc')).toBe('Add one');
    expect(app.text('.count')).toBe('2');
    expect(app.text('.inits')).toBe('1');
    await app.click('#inc');
    await app.reads('.count', '3');
  }, 60_000);

  it('starts changed logic clean, and says its variables cannot be carried', async () => {
    const app = await counter();
    await app.set({ python: python(5) });
    const answer = await app.answer();
    expect(answer).toMatchObject({ outcome: 'restarted', changed: ['logic'], carried: false });
    expect(answer.reason).toContain('Python');
    await app.reads('.count', '0');
    await app.click('#inc');
    await app.reads('.count', '5');
  }, 60_000);

  it('goes back to the last version that worked when the new logic does not compile', async () => {
    const app = await counter();
    const quiet = console.error;
    console.error = () => {};
    try {
      await app.set({ python: { files: { app: 'def inc(event=None:\n    pass\n' }, modules: ['app'] } });
      expect((await app.answer()).outcome).toBe('kept');
    } finally {
      console.error = quiet;
    }
    // The last version that worked is running again, and answers.
    await app.reads('.inits', '1');
    await app.click('#inc');
    expect(app.container.textContent).not.toContain('Runtime Error');
  }, 60_000);
});
