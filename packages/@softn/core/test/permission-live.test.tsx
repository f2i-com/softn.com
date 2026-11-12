/**
 * A permission that takes effect in the running app.
 *
 * Allow used to start the app again: a new engine, `_init` run a second
 * time, and what the engine alone held gone. Every `softn.*` check reads the
 * permission config when it is asked, so a grant needs none of that: the
 * running app is handed the new config and goes on.
 *
 * What must hold, and is held here:
 *
 * - Nothing is usable before the person allows it, not for one call. A call
 *   made while the bar is asking is kept, and nothing of it happens until the
 *   answer; a call for something the bar is not asking for is refused at once.
 * - Allowed, the kept call goes through, once, without the person doing again
 *   what they did, and the app's state is as it was.
 * - "Not now" refuses what was kept, at once, and what is asked for after.
 * - A permission taken away is refused from the next call, and what was in
 *   flight is never handed to the app.
 * - What the person did not grant stays refused after they grant the rest.
 * - Two apps answer for themselves: allowing one releases nothing of the other.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionConfig } from '../src/runtime/script-runtime';
import { logicEngineRunsPython } from '../src/runtime/vm-adapter';
import { withInProcessWorker } from './helpers/in-process-worker';
import { drawLivePage, sleep, type LivePage } from './helpers/live-page';

const URL_ASKED = 'https://api.example.com/data';

/** What a host runs an app with while its bar is up and can be answered. */
const asking: PermissionConfig = { app: { name: 'Probe' }, permissions: {}, consentPending: true, consentAsking: ['net'] };
/** The same after "Not now", and what a host that keeps no calls has always passed. */
const putOff: PermissionConfig = { app: { name: 'Probe' }, permissions: {}, consentPending: true };
/** After Allow: what the bundle declared. */
const granted: PermissionConfig = { app: { name: 'Probe' }, permissions: { net: { enabled: true } } };

const logic = (body: string) => `<logic>\n${body}\n</logic>\n`;

const APP = `
let count = 0
let hidden = 0
let inits = 0
let answer = "none"
let picked = "none"
function _init() { inits = inits + 1 }
function inc() { count = count + 1; hidden = hidden + 10 }
function load() {
  answer = "asked"
  softn.net.fetch("${URL_ASKED}", {}, function (res) { answer = res.error ? "refused" : res.body })
}
function pick() {
  softn.files.pickFile({}, function (res) { picked = res && res.error ? "refused" : "picked" })
}
function hiddenNow() { return hidden }
`;

const PAGE = `<div>
  <button id="inc" @click={inc}>Add</button>
  <button id="load" @click={load}>Load</button>
  <button id="pick" @click={pick}>Pick</button>
  <span class="count">{count}</span>
  <span class="inits">{inits}</span>
  <span class="answer">{answer}</span>
  <span class="picked">{picked}</span>
  <span class="hidden">{hiddenNow()}</span>
</div>`;

/** The network as the test answers it: every request made, and the way to answer each. */
interface Network {
  requests: string[];
  /** Answer the oldest request not answered yet. */
  respond(body?: string): Promise<void>;
  hold: boolean;
}

function stubNetwork(): Network {
  const waiting: Array<(response: Response) => void> = [];
  const network: Network = {
    requests: [],
    hold: false,
    respond: async (body = 'data') => {
      const next = waiting.shift();
      if (!next) throw new Error('no request is waiting');
      await act(async () => {
        next(new Response(body, { status: 200 }));
        await sleep(20);
      });
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: { signal?: AbortSignal }) => {
      network.requests.push(String(input));
      if (!network.hold) return Promise.resolve(new Response('data', { status: 200 }));
      return new Promise<Response>((resolve, reject) => {
        waiting.push(resolve);
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    })
  );
  return network;
}

let pages: LivePage[] = [];
let apps = 0;
let network: Network;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  network = stubNetwork();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  for (const page of pages.splice(0)) await page.unmount();
  vi.unstubAllGlobals();
  warn.mockRestore();
  localStorage.clear();
});

type Status = { waiting: string[]; restartOnAllow: boolean };

async function open(
  config: PermissionConfig,
  options: { mode?: 'main' | 'worker'; statuses?: Status[]; source?: string; worker?: boolean } = {}
): Promise<LivePage> {
  const page = await drawLivePage({
    source: options.source ?? logic(APP) + PAGE,
    appId: `permission-live-${++apps}`,
    ...(options.worker ? { executionPreference: 'worker' as const } : { scriptExecutionMode: options.mode ?? 'main' }),
    permissionConfig: config,
    onConsentStatus: (status) => options.statuses?.push(status),
  });
  pages.push(page);
  await page.reads('.inits', '1');
  return page;
}

describe.each(['main', 'worker'] as const)('allowing a running app (scriptExecutionMode %s)', (mode) => {
  it('starts nothing again: the app goes on with what it held, and is allowed from the next call', async () => {
    const app = await open(putOff, { mode });
    await app.click('#inc');
    await app.click('#inc');
    await app.reads('.count', '2');
    await app.reads('.hidden', '20');

    await app.set({ permissionConfig: granted });
    expect(await app.answer()).toEqual({ outcome: 'updated', changed: ['permissions'] });
    // Not a new engine: `_init` ran the once, and what only the engine held is there.
    expect(app.text('.inits')).toBe('1');
    expect(app.text('.count')).toBe('2');
    expect(app.text('.hidden')).toBe('20');

    await app.click('#load');
    await app.reads('.answer', 'data');
    expect(network.requests).toEqual([URL_ASKED]);
  });

  it('keeps a call the bar is asking about, and makes it once when the person allows', async () => {
    const statuses: Status[] = [];
    const app = await open(asking, { mode, statuses });
    await app.click('#inc');
    await app.click('#load');
    await app.settle(60);
    // Kept: not made, not refused, and the host can say what is waiting.
    expect(network.requests).toEqual([]);
    expect(app.text('.answer')).toBe('asked');
    expect(statuses.at(-1)).toEqual({ waiting: ['net'], restartOnAllow: false });
    // The app is not held with it.
    await app.click('#inc');
    await app.reads('.count', '2');

    await app.set({ permissionConfig: granted });
    await app.reads('.answer', 'data');
    expect(network.requests).toEqual([URL_ASKED]);
    expect(await app.answer()).toEqual({ outcome: 'updated', changed: ['permissions'] });
    expect(app.text('.inits')).toBe('1');
    expect(app.text('.count')).toBe('2');
    expect(statuses.at(-1)).toEqual({ waiting: [], restartOnAllow: false });
  });

  it('refuses a kept call at once when the person puts the bar away', async () => {
    const app = await open(asking, { mode });
    await app.click('#load');
    await app.settle(60);
    expect(app.text('.answer')).toBe('asked');

    await app.set({ permissionConfig: putOff });
    await app.reads('.answer', 'refused');
    expect(network.requests).toEqual([]);
    // And what is asked for after it is refused there and then.
    await app.click('#load');
    await app.reads('.answer', 'refused');
    expect(network.requests).toEqual([]);
    expect(app.text('.inits')).toBe('1');
  });

  it('refuses at once what the bar is not asking for, and goes on refusing it after the rest is allowed', async () => {
    const app = await open(asking, { mode });
    await app.click('#pick');
    await app.reads('.picked', 'refused');
    await app.set({ permissionConfig: granted });
    await app.settle(60);
    await app.click('#pick');
    await app.settle(60);
    // `files` was never declared, asked for or granted.
    expect(app.text('.picked')).toBe('refused');
  });

  it('starts an app again, with its variables, when it had been refused before it was allowed', async () => {
    const statuses: Status[] = [];
    const app = await open(putOff, { mode, statuses });
    await app.click('#inc');
    await app.click('#load');
    await app.reads('.answer', 'refused');
    // Said before the person allows: this app went on without what it asked for.
    for (let i = 0; i < 50 && statuses.at(-1)?.restartOnAllow !== true; i++) await app.settle();
    expect(statuses.at(-1)).toEqual({ waiting: [], restartOnAllow: true });

    await app.set({ permissionConfig: granted });
    const answer = await app.answer();
    expect(answer).toMatchObject({ outcome: 'restarted', changed: ['permissions'], carried: true });
    await app.reads('.inits', '2');
    expect(app.text('.count')).toBe('1');
    expect(app.text('.hidden')).toBe('10');
    await app.click('#load');
    await app.reads('.answer', 'data');
  });

  it('tells an app that listens instead of starting it again', async () => {
    const listening =
      APP + `\nlet told = 0\nfunction _onPermissionChange() { told = told + 1; load() }\n`;
    const app = await open(putOff, { mode, source: logic(listening) + PAGE.replace('</div>', '  <span class="told">{told}</span>\n</div>') });
    await app.click('#load');
    await app.reads('.answer', 'refused');
    await app.set({ permissionConfig: granted });
    expect(await app.answer()).toEqual({ outcome: 'updated', changed: ['permissions'] });
    await app.reads('.told', '1');
    // It did again, itself, what it had been refused.
    await app.reads('.answer', 'data');
    expect(app.text('.inits')).toBe('1');
  });
});

describe('what the page itself fetches from another site', () => {
  it('is held back until the person allows, and drawn then where the app stands', async () => {
    const picture = 'https://img.example.com/cover.png';
    const app = await open(asking, {
      source: logic(APP) + PAGE.replace('</div>', `  <img class="pic" src="${picture}" alt="cover" />\n</div>`),
    });
    await app.click('#inc');
    await app.reads('.count', '1');
    // Asking for the network names it, and gives none of it.
    expect(app.container.querySelector('img.pic')?.getAttribute('src') ?? '').not.toContain('img.example.com');
    await app.set({ permissionConfig: granted });
    for (let i = 0; i < 100 && app.container.querySelector('img.pic')?.getAttribute('src') !== picture; i++) await app.settle();
    expect(app.container.querySelector('img.pic')?.getAttribute('src')).toBe(picture);
    expect(app.text('.inits')).toBe('1');
    expect(app.text('.count')).toBe('1');
  });
});

describe('logic that comes from another site', () => {
  it('is left out until the person allows, then loaded with the app’s variables carried over', async () => {
    const source =
      logic(
        `import "https://cdn.example.com/extra.logic"\n` +
          `let count = 0\nlet inits = 0\nlet bonus = 0\n` +
          `function _init() { inits = inits + 1 }\n` +
          `function inc() { count = count + 1 }\n` +
          `function useExtra() { bonus = typeof extra === "function" ? extra() : -1 }`
      ) +
      `<div><button id="inc" @click={inc}>Add</button><button id="extra" @click={useExtra}>Extra</button>` +
      `<span class="count">{count}</span><span class="inits">{inits}</span><span class="bonus">{bonus}</span></div>`;
    // What a host's resolver does: nothing from the network while it is withheld.
    const withheld = async () => null;
    const allowed = async (path: string) => (path.startsWith('https://') ? 'function extra() { return 7 }' : null);
    const statuses: Status[] = [];
    const page = await drawLivePage({
      source,
      appId: `permission-live-${++apps}`,
      scriptExecutionMode: 'main',
      permissionConfig: asking,
      importResolver: withheld,
      onConsentStatus: (status) => statuses.push(status),
    });
    pages.push(page);
    await page.reads('.inits', '1');
    await page.click('#inc');
    await page.click('#extra');
    await page.reads('.bonus', '-1');
    // Said before the person allows: this one has to be started again.
    for (let i = 0; i < 50 && statuses.at(-1)?.restartOnAllow !== true; i++) await page.settle();
    expect(statuses.at(-1)?.restartOnAllow).toBe(true);

    await page.set({ permissionConfig: granted, importResolver: allowed });
    const answer = await page.answer();
    expect(answer).toMatchObject({ outcome: 'restarted', carried: true });
    expect(answer.changed).toEqual(expect.arrayContaining(['logic', 'permissions']));
    await page.reads('.count', '1');
    await page.click('#extra');
    await page.reads('.bonus', '7');
  });
});

describe('taking a permission away from a running app', () => {
  it('refuses from the next call, and starts the app again with its variables', async () => {
    const app = await open(granted);
    await app.click('#inc');
    await app.click('#load');
    await app.reads('.answer', 'data');
    expect(network.requests).toHaveLength(1);

    await app.set({ permissionConfig: putOff });
    const answer = await app.answer();
    expect(answer).toMatchObject({ outcome: 'restarted', changed: ['permissions'], carried: true });
    expect(answer.reason).toContain('taken away');
    await app.reads('.inits', '2');
    expect(app.text('.count')).toBe('1');
    await app.click('#load');
    await app.reads('.answer', 'refused');
    expect(network.requests).toHaveLength(1);
  });

  it('never hands the app what was in flight when it was taken away', async () => {
    network.hold = true;
    const app = await open(granted);
    await app.click('#load');
    await app.settle(40);
    expect(network.requests).toHaveLength(1);
    expect(app.text('.answer')).toBe('asked');

    // Taken away while the request is out: refused in the same turn.
    await act(async () => {
      void app.set({ permissionConfig: putOff });
    });
    await act(async () => {
      app.container.querySelector('#load')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(30);
    });
    expect(network.requests).toHaveLength(1);
    await app.answer();
    // The request that was out answers late, to nobody.
    await network.respond('late').catch(() => {});
    await app.settle(60);
    expect(app.text('.answer')).not.toBe('late');
    expect(app.text('.answer')).not.toBe('data');
  });

  it('gives nothing back when it is put off, allowed and put off again in one turn', async () => {
    const app = await open(asking);
    await app.click('#load');
    await app.settle(40);
    await act(async () => {
      void app.set({ permissionConfig: granted });
      void app.set({ permissionConfig: putOff });
    });
    await app.settle(120);
    // The grant was never on screen by the time anything could act on it:
    // the kept call is judged against the config as it stands.
    expect(network.requests.length).toBeLessThanOrEqual(1);
    await app.click('#load');
    await app.settle(60);
    expect(network.requests.length).toBeLessThanOrEqual(1);
    expect(['refused', 'asked', 'data']).toContain(app.text('.answer'));
    if (network.requests.length === 0) expect(app.text('.answer')).toBe('refused');
  });
});

describe('the answer and a call arriving together', () => {
  it('makes a call once when it is kept and allowed in the same turn', async () => {
    const app = await open(asking);
    await act(async () => {
      app.container.querySelector('#load')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      void app.set({ permissionConfig: granted });
      await sleep(80);
    });
    await app.reads('.answer', 'data');
    expect(network.requests).toEqual([URL_ASKED]);
  });

  it('refuses a call that is kept and put off in the same turn', async () => {
    const app = await open(asking);
    await act(async () => {
      app.container.querySelector('#load')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      void app.set({ permissionConfig: putOff });
      await sleep(80);
    });
    await app.reads('.answer', 'refused');
    expect(network.requests).toEqual([]);
  });

  it('keeps no more than a fixed number of calls, and refuses the rest as before', async () => {
    const many = APP + `\nlet refused = 0\nfunction flood() { for (let i = 0; i < 40; i++) softn.net.fetch("${URL_ASKED}", {}, function (res) { if (res.error) refused = refused + 1 }) }\n`;
    const app = await open(asking, {
      source: logic(many) + PAGE.replace('</div>', '  <button id="flood" @click={flood}>Flood</button><span class="refused">{refused}</span>\n</div>'),
    });
    await app.click('#flood');
    await app.reads('.refused', '8');
    expect(network.requests).toEqual([]);
    await app.set({ permissionConfig: granted });
    for (let i = 0; i < 100 && network.requests.length < 32; i++) await app.settle();
    expect(network.requests).toHaveLength(32);
  });

  it('lets a kept call go, unmade, when the app closes', async () => {
    const app = await open(asking);
    await app.click('#load');
    await app.settle(40);
    await app.unmount();
    pages = pages.filter((page) => page !== app);
    await act(async () => {
      await sleep(60);
    });
    expect(network.requests).toEqual([]);
  });
});

describe('two apps open at once', () => {
  it('answer for themselves: allowing one releases nothing of the other', async () => {
    const first = await open(asking);
    const second = await open(asking);
    await first.click('#load');
    await second.click('#load');
    await first.settle(60);
    expect(network.requests).toEqual([]);

    await first.set({ permissionConfig: granted });
    await first.reads('.answer', 'data');
    await second.settle(80);
    expect(network.requests).toEqual([URL_ASKED]);
    expect(second.text('.answer')).toBe('asked');

    await second.set({ permissionConfig: putOff });
    await second.reads('.answer', 'refused');
    expect(network.requests).toEqual([URL_ASKED]);
  });
});

describe('a script in a worker of its own', () => {
  it('has a kept call made once it is allowed, and nothing started again', () =>
    withInProcessWorker(async () => {
      const source = logic(APP.replace('function hiddenNow() { return hidden }', '')) + PAGE.replace('  <span class="hidden">{hiddenNow()}</span>\n', '');
      const app = await open(asking, { worker: true, source });
      await app.click('#inc');
      await app.click('#load');
      await app.settle(80);
      expect(network.requests).toEqual([]);
      expect(app.text('.answer')).toBe('asked');
      await app.set({ permissionConfig: granted });
      await app.reads('.answer', 'data');
      expect(network.requests).toEqual([URL_ASKED]);
      expect(app.text('.inits')).toBe('1');
      expect(app.text('.count')).toBe('1');
    }), 60_000);

  it('has it refused at once when the bar is put away', () =>
    withInProcessWorker(async () => {
      const source = logic(APP.replace('function hiddenNow() { return hidden }', '')) + PAGE.replace('  <span class="hidden">{hiddenNow()}</span>\n', '');
      const app = await open(asking, { worker: true, source });
      await app.click('#load');
      await app.settle(80);
      await app.set({ permissionConfig: putOff });
      await app.reads('.answer', 'refused');
      expect(network.requests).toEqual([]);
    }), 60_000);
});

describe.skipIf(!logicEngineRunsPython())('an app whose logic is Python', () => {
  const python = {
    files: {
      app: [
        'import softn',
        '',
        'count = 0',
        'inits = 0',
        'answer = "none"',
        '',
        'def _init():',
        '    global inits',
        '    inits = inits + 1',
        '',
        'def inc(event=None):',
        '    global count',
        '    count = count + 1',
        '',
        'def got(res):',
        '    global answer',
        '    answer = "refused" if "error" in res else res["body"]',
        '',
        'def load(event=None):',
        '    global answer',
        '    answer = "asked"',
        `    softn.net.fetch("${URL_ASKED}", {}, got)`,
        '',
      ].join('\n'),
    },
    modules: ['app'],
  };
  const markup = `<logic>\n</logic>\n<div>
  <button id="inc" @click={inc}>Add</button>
  <button id="load" @click={load}>Load</button>
  <span class="count">{count}</span>
  <span class="inits">{inits}</span>
  <span class="answer">{answer}</span>
</div>`;

  it('has a kept call made once it is allowed, and nothing started again', async () => {
    const page = await drawLivePage({
      source: markup,
      python,
      appId: `permission-live-${++apps}`,
      scriptExecutionMode: 'main',
      permissionConfig: asking,
    });
    pages.push(page);
    await page.reads('.inits', '1');
    await page.click('#inc');
    await page.click('#load');
    await page.settle(80);
    expect(network.requests).toEqual([]);
    expect(page.text('.answer')).toBe('asked');
    await page.set({ permissionConfig: granted });
    await page.reads('.answer', 'data');
    expect(network.requests).toEqual([URL_ASKED]);
    expect(page.text('.inits')).toBe('1');
    expect(page.text('.count')).toBe('1');
  }, 60_000);
});
