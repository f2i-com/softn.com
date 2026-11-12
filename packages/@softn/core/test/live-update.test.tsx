/**
 * An open app handed a newer version of itself.
 *
 * The renderer started the app again for every change to its source: a new
 * engine, `_init` run again, and what the engine alone held gone. It now
 * looks at what changed. Markup and styles are drawn where the app stands,
 * by the logic that is running. Logic that changed starts in a new engine
 * with the app's variables carried in, or clean when they cannot be. A
 * version with a problem is not shown at all: the last one that worked
 * stays, and the answer says what is wrong.
 *
 * On the main-thread engine here, in each of its three modes; in a worker and
 * for Python in live-update-engines.test.tsx.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createLiveApp } from '../src/runtime/live-app';
import { logicEngineIsSandboxed } from '../src/runtime/vm-adapter';
import { drawLivePage, type LivePage } from './helpers/live-page';

let page: LivePage | null = null;
let apps = 0;

afterEach(async () => {
  await page?.unmount();
  page = null;
  localStorage.clear();
});

const logic = (body: string) => `<logic>\n${body}\n</logic>\n`;

/** Ask the app for something, and let the page be drawn until it has answered. */
async function asked<T>(on: LivePage, ask: () => Promise<T>): Promise<T> {
  const { act } = await import('react');
  let answer: { value: T } | null = null;
  await act(async () => {
    void ask().then((value) => {
      answer = { value };
    });
  });
  for (let i = 0; i < 400 && answer === null; i++) await on.settle(15);
  if (answer === null) throw new Error('the app did not answer');
  return (answer as { value: T }).value;
}

const COUNTER = `
let count = 0
let secret = 0
let inits = 0
let step = 1
function _init() { inits = inits + 1 }
function inc() { count = count + step; secret = secret + 10 }
`;

const PAGE = `<div>
  <button id="inc" @click={inc}>Add</button>
  <span class="count">{count}</span>
  <span class="inits">{inits}</span>
</div>`;

async function counter(mode: 'main' | 'worker' = 'main'): Promise<LivePage> {
  page = await drawLivePage({ source: logic(COUNTER) + PAGE, appId: `live-update-${++apps}`, scriptExecutionMode: mode });
  await page.reads('.inits', '1');
  await page.click('#inc');
  await page.click('#inc');
  await page.click('#inc');
  await page.reads('.count', '3');
  return page;
}

describe.each(['main', 'worker'] as const)('an open app handed new markup (scriptExecutionMode %s)', (mode) => {
  it('draws it with the state it has, by the logic that is running', async () => {
    const app = await counter(mode);
    await app.set({
      source:
        logic(COUNTER) +
        `<div>
  <h1 class="title">Counter</h1>
  <button id="inc" @click={inc}>Add one</button>
  <span class="count">{count}</span>
  <span class="inits">{inits}</span>
</div>`,
    });
    expect(await app.answer()).toEqual({ outcome: 'updated', changed: ['page'] });
    expect(app.text('.title')).toBe('Counter');
    expect(app.text('#inc')).toBe('Add one');
    // Not started again: the count stands, and `_init` ran the once.
    expect(app.text('.count')).toBe('3');
    expect(app.text('.inits')).toBe('1');
    await app.click('#inc');
    await app.reads('.count', '4');
  });

  it('hands the page a variable it has only now begun to read, as the engine holds it', async () => {
    const app = await counter(mode);
    // `secret` was the engine's alone: no markup named it, and the page's
    // copy of it was the one from when the script loaded.
    await app.set({
      source: logic(COUNTER) + PAGE.replace('</div>', '  <span class="secret">{secret}</span>\n</div>'),
    });
    expect((await app.answer()).outcome).toBe('updated');
    await app.reads('.secret', '30');
    await app.click('#inc');
    await app.reads('.secret', '40');
    await app.reads('.count', '4');
  });

  it('swaps its styles and starts nothing again', async () => {
    const app = await counter(mode);
    await app.set({ source: logic(COUNTER) + PAGE + '\n<style>\n.count { color: rgb(1, 2, 3); }\n</style>' });
    expect(await app.answer()).toEqual({ outcome: 'updated', changed: ['styles'] });
    for (let i = 0; i < 100 && !app.container.querySelector('style')?.textContent?.includes('rgb(1, 2, 3)'); i++) await app.settle();
    expect(app.container.querySelector('style')?.textContent).toContain('rgb(1, 2, 3)');
    expect(app.text('.count')).toBe('3');
    expect(app.text('.inits')).toBe('1');
  });

  it('stays on the page the person had open', async () => {
    const source = (extra: string) =>
      logic(`let page = "home"\nlet visits = 0\nfunction go(name) { page = name; visits = visits + 1 }`) +
      `<div>
  <nav><button id="home" @click={() => go("home")}>Home</button><button id="about" @click={() => go("about")}>About</button>${extra}</nav>
  #if (page === "home")
    <p class="shown">Home page</p>
  #elseif (page === "about")
    <p class="shown">About page</p>
  #elseif (page === "help")
    <p class="shown">Help page</p>
  #end
</div>`;
    page = await drawLivePage({ source: source(''), appId: `live-update-${++apps}`, scriptExecutionMode: mode });
    await page.reads('.shown', 'Home page');
    await page.click('#about');
    await page.reads('.shown', 'About page');
    // A page is added, and the navigation lists it.
    await page.set({ source: source('<button id="help" @click={() => go("help")}>Help</button>') });
    expect((await page.answer()).outcome).toBe('updated');
    expect(page.text('.shown')).toBe('About page');
    await page.click('#help');
    await page.reads('.shown', 'Help page');
  });
});

describe('an open app handed new logic', () => {
  it('starts it with the variables carried over, and runs its start-up again', async () => {
    const app = await counter();
    await app.set({ source: logic(COUNTER.replace('count = count + step', 'count = count + step + 1')) + PAGE });
    const answer = await app.answer();
    expect(answer).toMatchObject({ outcome: 'restarted', changed: ['logic'], carried: true });
    expect(answer.reason).toContain('carried over');
    await app.reads('.count', '3');
    // Carried in at 1, and the new logic's `_init` ran over it.
    await app.reads('.inits', '2');
    await app.click('#inc');
    await app.reads('.count', '5');
  });

  it('takes a starting value the author changed, for a variable the app had not moved', async () => {
    const app = await counter();
    await app.set({ source: logic(COUNTER.replace('let step = 1', 'let step = 5')) + PAGE });
    expect((await app.answer()).carried).toBe(true);
    await app.reads('.count', '3');
    await app.click('#inc');
    await app.reads('.count', '8');
  });

  it('carries what only the engine held, and what was typed and not yet sent to it', async () => {
    const before = `let name = ""\nlet notes = []\nfunction add() { notes = notes.concat([name]) }\nfunction total() { return notes.length }`;
    const markup = `<div><input id="name" :bind={name} /><button id="add" @click={add}>Add</button><span class="total">{total()}</span><span class="name">{name}</span></div>`;
    page = await drawLivePage({ source: logic(before) + markup, appId: `live-update-${++apps}`, scriptExecutionMode: 'main' });
    await page.reads('.total', '0');
    const input = page.container.querySelector('#name') as HTMLInputElement;
    const { act } = await import('react');
    const type = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    await type('one');
    await page.click('#add');
    await page.reads('.total', '1');
    // Typed, and no function called since: only the page holds it.
    await type('two');
    await page.set({ source: logic(before.replace('return notes.length', 'return notes.length * 10')) + markup });
    expect((await page.answer()).carried).toBe(true);
    await page.reads('.total', '10');
    await page.reads('.name', 'two');
    await page.click('#add');
    await page.reads('.total', '20');
  });

  it.each([
    ['holds a Set', 'let seen = new Set()', 'seen'],
    ['holds an object made by a class', 'class Game { constructor() { this.n = 0 } }\nlet game = new Game()\nfunction play() { game.n = 1 }', 'game'],
  ])('starts clean, and says why, when a variable %s', async (_what, extra, name) => {
    const body = COUNTER + extra + (extra.includes('play') ? '' : '\nfunction play() { seen.add(1) }');
    page = await drawLivePage({
      source: logic(body) + PAGE.replace('</div>', '  <button id="play" @click={play}>Play</button>\n</div>'),
      appId: `live-update-${++apps}`,
      scriptExecutionMode: 'main',
    });
    await page.reads('.inits', '1');
    await page.click('#inc');
    await page.click('#play');
    await page.reads('.count', '1');
    await page.set({
      source: logic(body.replace('secret + 10', 'secret + 20')) + PAGE.replace('</div>', '  <button id="play" @click={play}>Play</button>\n</div>'),
    });
    const answer = await page.answer();
    expect(answer).toMatchObject({ outcome: 'restarted', changed: ['logic'], carried: false });
    expect(answer.reason).toContain(`\`${name}\``);
    // Nothing of the old run under the new logic: not the count, not `inits`.
    await page.reads('.count', '0');
    await page.reads('.inits', '1');
  });

  it('starts clean when a variable changed shape', async () => {
    const body = (user: string) => `let user = ${user}\nlet count = 0\nfunction work() { user.name = "Bo"; count = count + 1 }`;
    const markup = `<div><button id="work" @click={work}>Work</button><span class="count">{count}</span></div>`;
    page = await drawLivePage({ source: logic(body('{ name: "" }')) + markup, appId: `live-update-${++apps}`, scriptExecutionMode: 'main' });
    await page.reads('.count', '0');
    await page.click('#work');
    await page.reads('.count', '1');
    await page.set({ source: logic(body('{ first: "", last: "" }')) + markup });
    const answer = await page.answer();
    expect(answer).toMatchObject({ outcome: 'restarted', carried: false });
    expect(answer.reason).toContain('`user` has changed shape');
    await page.reads('.count', '0');
  });

  it('never loses what the app stored', async () => {
    const body = (label: string) =>
      `let label = "${label}"\nlet saves = 0\nfunction save() { db.create("notes", { text: "kept" }); saves = saves + 1 }\nfunction stored() { return db.query("notes").length }`;
    const markup = `<div><button id="save" @click={save}>Save</button><span class="stored">{stored()}</span><span class="label">{label}</span><span class="saves">{saves}</span></div>`;
    page = await drawLivePage({ source: logic(body('a')) + markup, appId: `live-update-${++apps}`, scriptExecutionMode: 'main' });
    await page.reads('.stored', '0');
    await page.click('#save');
    await page.reads('.stored', '1');
    await page.set({ source: logic(body('b')) + markup });
    expect((await page.answer()).outcome).toBe('restarted');
    await page.reads('.label', 'b');
    expect(page.text('.stored')).toBe('1');
  });
});

describe('a newer version with a problem', () => {
  it('keeps the last page that worked when the markup does not parse, and takes the next that does', async () => {
    const app = await counter();
    await app.set({ source: logic(COUNTER) + '<Stack><span class="count">{count}</span><p>half' });
    const answer = await app.answer();
    expect(answer.outcome).toBe('kept');
    expect(answer.problem).toMatch(/Unclosed tag/);
    // The app is as it was, and still answers.
    expect(app.text('.count')).toBe('3');
    await app.click('#inc');
    await app.reads('.count', '4');
    expect(app.container.querySelector('[data-softn-notice="update"]')?.textContent).toContain('the last version that worked is still showing');
    await app.set({ source: logic(COUNTER) + PAGE.replace('Add', 'Add more') });
    expect((await app.answer()).outcome).toBe('updated');
    expect(app.text('#inc')).toBe('Add more');
    expect(app.text('.count')).toBe('4');
    expect(app.text('.inits')).toBe('1');
    expect(app.container.querySelector('[data-softn-notice="update"]')).toBeNull();
  });

  it('keeps the logic that is running when the new logic does not parse', async () => {
    const app = await counter();
    await app.set({ source: logic(COUNTER + '\nfunction half( {') + PAGE });
    const answer = await app.answer();
    expect(answer.outcome).toBe('kept');
    expect(answer.problem).toMatch(/logic does not parse/);
    await app.click('#inc');
    await app.reads('.count', '4');
    // Not started again: its `_init` ran the once.
    expect(app.text('.inits')).toBe('1');
    await app.set({ source: logic(COUNTER.replace('secret + 10', 'secret + 1')) + PAGE });
    expect(await app.answer()).toMatchObject({ outcome: 'restarted', carried: true });
    await app.reads('.count', '4');
  });

  it('goes back to the last version that worked when the new logic fails as it starts', async () => {
    const app = await counter();
    const quiet = console.error;
    console.error = () => {};
    try {
      await app.set({ source: logic(COUNTER + '\nnoSuchFunction()') + PAGE });
      const answer = await app.answer();
      expect(answer.outcome).toBe('kept');
      expect(answer.problem).toMatch(/noSuchFunction/);
    } finally {
      console.error = quiet;
    }
    // The last version that worked, with its variables: the page was never
    // replaced by the error.
    await app.reads('.count', '3');
    await app.click('#inc');
    await app.reads('.count', '4');
    expect(app.container.textContent).not.toContain('Runtime Error');
  });
});

describe('another app in the same place', () => {
  it('starts clean: nothing the first app held shows as the second app’s', async () => {
    const first = logic(`let title = "First app"\nlet pages = ["home", "about"]\nlet count = 0\nfunction inc() { count = count + 1 }`);
    const second = logic(`let title = "Second app"\nlet pages = ["home"]\nlet count = 0\nfunction inc() { count = count + 1 }`);
    const markup = `<div><h1 class="title">{title}</h1><span class="pages">{pages.length}</span><button id="inc" @click={inc}>Add</button><span class="count">{count}</span></div>`;
    page = await drawLivePage({ source: first + markup, appId: `live-update-${++apps}`, scriptExecutionMode: 'main' });
    await page.reads('.title', 'First app');
    await page.click('#inc');
    await page.reads('.count', '1');
    // An editor opens another project in the canvas the first was on.
    await page.set({ source: second + markup, appId: `live-update-${++apps}` });
    expect(await page.answer()).toMatchObject({ outcome: 'restarted', carried: false });
    await page.reads('.title', 'Second app');
    expect(page.text('.pages')).toBe('1');
    expect(page.text('.count')).toBe('0');
  });
});

// Only where the engine stops a call that runs for ever: the host's own
// JavaScript would hang on it.
describe.skipIf(!logicEngineIsSandboxed())('an app whose logic has stopped', () => {
  it('is started again by a newer version, and not left dead under a new page', async () => {
    const body = COUNTER + '\nfunction spin() { while (true) {} }\n';
    const markup = PAGE.replace('</div>', '  <button id="spin" @click={spin}>Spin</button>\n</div>');
    page = await drawLivePage({ source: logic(body) + markup, appId: `live-update-${++apps}`, scriptExecutionMode: 'main', failureNotices: false });
    await page.reads('.inits', '1');
    await page.click('#inc');
    await page.reads('.count', '1');
    const quiet = console.error;
    console.error = () => {};
    try {
      await page.click('#spin');
      await page.settle(100);
      // Stopped: a press is ignored.
      await page.click('#inc');
      expect(page.text('.count')).toBe('1');
      await page.set({ source: logic(body) + markup.replace('Add', 'Add one') });
      const answer = await page.answer();
      expect(answer.outcome).toBe('restarted');
      expect(answer.reason).toContain('had stopped');
    } finally {
      console.error = quiet;
    }
    await page.click('#inc');
    await page.reads('.count', '2');
  }, 60_000);
});

describe('a running app as something a host holds', () => {
  it('answers each update with what became of it, and gathers a burst into one', async () => {
    const live = createLiveApp();
    page = await drawLivePage({ app: live, source: logic(COUNTER) + PAGE, appId: `live-update-${++apps}`, scriptExecutionMode: 'main' });
    await page.reads('.inits', '1');
    await page.click('#inc');
    await page.reads('.count', '1');
    expect(live.shown?.source).toBe(logic(COUNTER) + PAGE);

    // Ten files written one after another.
    const answers = await asked(page, () =>
      Promise.all(Array.from({ length: 10 }, (_, i) => live.update({ source: logic(COUNTER) + PAGE.replace('Add', `Add ${i}`) })))
    );
    // Every caller hears of the one update that covered them.
    expect(new Set(answers.map((answer) => answer.outcome))).toEqual(new Set(['updated']));
    expect(page.text('#inc')).toBe('Add 9');
    expect(page.text('.count')).toBe('1');
    expect(page.text('.inits')).toBe('1');
    expect(live.shown?.source).toContain('Add 9');
    // One answer through onUpdate, not ten.
    expect(page.results.length).toBeLessThanOrEqual(2);
  });

  it('says a version with a problem was kept back, and what is on screen', async () => {
    const live = createLiveApp();
    page = await drawLivePage({ app: live, source: logic(COUNTER) + PAGE, appId: `live-update-${++apps}`, scriptExecutionMode: 'main' });
    await page.reads('.inits', '1');
    const answer = await asked(page, () => live.update({ source: logic(COUNTER) + '<Stack><p>half' }));
    expect(answer.outcome).toBe('kept');
    expect(live.wanted?.source).toContain('<Stack>');
    expect(live.shown?.source).toBe(logic(COUNTER) + PAGE);
  });

  it('starts the app clean when a person asks', async () => {
    const live = createLiveApp();
    page = await drawLivePage({ app: live, source: logic(COUNTER) + PAGE, appId: `live-update-${++apps}`, scriptExecutionMode: 'main' });
    await page.reads('.inits', '1');
    await page.click('#inc');
    await page.reads('.count', '1');
    const answer = await asked(page, () => live.restart());
    expect(answer).toMatchObject({ outcome: 'restarted', carried: false });
    await page.reads('.count', '0');
    await page.reads('.inits', '1');
  });
});
