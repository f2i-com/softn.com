/**
 * `_onHide()` and `_onShow()`: logic is told when its app goes to the
 * background and when it comes back.
 *
 * A host that keeps several apps open shows one (SoftN Web's tabs: the
 * renderer's `active`), and a browser's tab can be put behind another. A
 * game went on being played in both, and what logic had to listen for, the
 * window's `blur`, says nothing when another app is chosen inside the host.
 * The runtime calls the two functions where the logic defines them, the way
 * it calls `_init()`.
 */

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { logicEngineRunsPython } from '../src/runtime/vm-adapter';
import { withInProcessWorker } from './helpers/in-process-worker';
import { drawLivePage, type LivePage } from './helpers/live-page';

const APP = `<logic>
let log = "started"
let ticks = 0
function _init() { log = log + " init" }
function _onHide() { log = log + " hide" }
function _onShow() { log = log + " show" }
function step() { ticks = ticks + 1 }
</logic>
<div>
  <button id="step" @click={step}>Step</button>
  <span class="log">{log}</span>
  <span class="ticks">{ticks}</span>
</div>`;

const pages: LivePage[] = [];
let apps = 0;

/** Put the document in the background or back, as a browser does: the state, then the event. */
async function showDocument(shown: boolean): Promise<void> {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (shown ? 'visible' : 'hidden') });
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

afterEach(async () => {
  for (const page of pages.splice(0)) await page.unmount();
  // The document's own answer again.
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

async function open(props: Partial<Parameters<typeof drawLivePage>[0]> = {}): Promise<LivePage> {
  const page = await drawLivePage({ source: APP, appId: `hide-show-${++apps}`, scriptExecutionMode: 'main', ...props });
  pages.push(page);
  return page;
}

describe('an app that goes to the background and comes back', () => {
  it('is told when the host shows another app, and when it shows this one again', async () => {
    const app = await open({ active: true });
    await app.reads('.log', 'started init');

    await app.set({ active: false });
    await app.reads('.log', 'started init hide');
    await app.set({ active: true });
    await app.reads('.log', 'started init hide show');

    // Once for each change, and not again for a draw that changes nothing.
    await app.click('#step');
    await app.set({ active: true });
    await app.settle(40);
    expect(app.text('.log')).toBe('started init hide show');
    expect(app.text('.ticks')).toBe('1');
  });

  it('is told when the browser hides the tab, and when it shows it again', async () => {
    const app = await open();
    await app.reads('.log', 'started init');
    await showDocument(false);
    await app.reads('.log', 'started init hide');
    await showDocument(true);
    await app.reads('.log', 'started init hide show');
  });

  it('is told once, not twice, when it is hidden both ways at once', async () => {
    const app = await open();
    await app.reads('.log', 'started init');
    await app.set({ active: false });
    await app.reads('.log', 'started init hide');
    // Already in the background: the tab going too is no news to it.
    await showDocument(false);
    await app.settle(40);
    expect(app.text('.log')).toBe('started init hide');
    // Shown again only when both are: the tab first, then the host's choice.
    await showDocument(true);
    await app.settle(40);
    expect(app.text('.log')).toBe('started init hide');
    await app.set({ active: true });
    await app.reads('.log', 'started init hide show');
  });

  it('started in the background, is told so once, after _init', async () => {
    const app = await open({ active: false });
    await app.reads('.log', 'started init hide');
    await app.set({ active: true });
    await app.reads('.log', 'started init hide show');
  });

  it('is asked nothing when it defines neither function', async () => {
    const quiet = `<logic>
let n = 0
function add() { n = n + 1 }
</logic>
<div><button id="add" @click={add}>Add</button><span class="n">{n}</span></div>`;
    const app = await open({ source: quiet });
    await app.click('#add');
    await app.set({ active: false });
    await app.set({ active: true });
    await app.click('#add');
    await app.reads('.n', '2');
  });

  it('is told the same when its logic runs in a worker of its own', () =>
    withInProcessWorker(async () => {
      const app = await open({ scriptExecutionMode: 'worker', executionPreference: 'worker' });
      await app.reads('.log', 'started init');
      await app.set({ active: false });
      await app.reads('.log', 'started init hide');
      await app.set({ active: true });
      await app.reads('.log', 'started init hide show');
    }), 60_000);
});

describe('an app handed newer logic, which takes over its variables', () => {
  // Found by review, 2026-11-13. New logic was started as though on screen
  // whatever the logic before it had been told. In the background it was told
  // `_onHide()` a second time over variables that already said so; and shown
  // again in the same change that handed it the new logic, it was never told
  // `_onShow()`, so a game that had paused itself stayed paused.
  const NEWER = APP.replace('log = log + " show"', 'log = log + " SHOWN"');

  it('in the background, is not told it is hidden a second time, and is told when it is shown', async () => {
    const app = await open({ active: true });
    await app.reads('.log', 'started init');
    await app.set({ active: false });
    await app.reads('.log', 'started init hide');

    await app.set({ source: NEWER });
    expect(await app.answer()).toMatchObject({ outcome: 'restarted', carried: true });
    // Its start-up ran over what was carried, and nothing more was said.
    await app.reads('.log', 'started init hide init');
    await app.settle(40);
    expect(app.text('.log')).toBe('started init hide init');

    await app.set({ active: true });
    await app.reads('.log', 'started init hide init SHOWN');
  });

  it('shown again in the same change that hands it the new logic, is told so', async () => {
    const app = await open({ active: true });
    await app.set({ active: false });
    await app.reads('.log', 'started init hide');

    await app.set({ source: NEWER, active: true });
    expect(await app.answer()).toMatchObject({ outcome: 'restarted', carried: true });
    // Told once that it is shown, by the logic that was still running when the
    // change came; the new logic starts over variables that already say so,
    // and is told nothing more.
    await app.reads('.log', 'started init hide show init');
    await app.settle(40);
    expect(app.text('.log')).toBe('started init hide show init');
    // And the new logic is the one told from here on.
    await app.set({ active: false });
    await app.reads('.log', 'started init hide show init hide');
    await app.set({ active: true });
    await app.reads('.log', 'started init hide show init hide SHOWN');
  });

  it('on screen throughout, is told nothing', async () => {
    const app = await open({ active: true });
    await app.reads('.log', 'started init');
    await app.set({ source: NEWER });
    expect(await app.answer()).toMatchObject({ outcome: 'restarted', carried: true });
    await app.reads('.log', 'started init init');
    await app.settle(40);
    expect(app.text('.log')).toBe('started init init');
  });
});

describe.skipIf(!logicEngineRunsPython())('an app whose logic is Python', () => {
  it('is told by the same two names', async () => {
    const python = {
      files: {
        app: ['log = "started"', '', '', 'def _init():', '    global log', '    log = log + " init"', '', '', 'def _onHide():', '    global log', '    log = log + " hide"', '', '', 'def _onShow():', '    global log', '    log = log + " show"', ''].join('\n'),
      },
      modules: ['app'],
    };
    const app = await open({ source: '<logic>\n</logic>\n<div><span class="log">{log}</span></div>', python });
    await app.reads('.log', 'started init');
    await app.set({ active: false });
    await app.reads('.log', 'started init hide');
    await app.set({ active: true });
    await app.reads('.log', 'started init hide show');
  }, 60_000);
});
