/**
 * What fails in an app is said on the page.
 *
 * A page that did not parse played as an empty app, and a handler that threw,
 * or ran until the engine stopped it, said so to the console alone: the bar
 * the renderer has for a script that will not start was never told. Run here
 * through the real engine, in the renderer, as an app runs.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from '../src/parser';
import { SoftNRenderer, type SoftNRendererProps } from '../src/loader/SoftNRenderer';
import { logicEngineIsSandboxed } from '../src/runtime/vm-adapter';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The real engine: its first start in a run is seconds, and a runaway loop spends its whole budget.
vi.setConfig({ testTimeout: 90_000 });

/**
 * What only an engine that holds the script can do. On the host's own
 * JavaScript (`test:host-js`) a loop that never ends is this page's own, which
 * nothing can interrupt, and a page's code is given the real document.
 */
const sandboxed = it.skipIf(!logicEngineIsSandboxed());

let container: HTMLElement;
let root: Root;
let made = 0;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  await act(async () => root?.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function until(ready: () => unknown, what: string): Promise<void> {
  for (let i = 0; i < 1600 && !ready(); i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
  expect(ready(), what).toBeTruthy();
}

const notices = () => [...container.querySelectorAll('[data-softn-notice="failure"]')];

async function draw(source: string, props: Partial<SoftNRendererProps> = {}): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(<SoftNRenderer source={source} appId={`failure-notices-${++made}`} {...props} />);
  });
}

/** An app of two buttons, drawn and with its script loaded. */
async function app(logic: string, props: Partial<SoftNRendererProps> = {}): Promise<void> {
  await draw(
    `<div><p id="count">{count}</p><button id="go" @click={go}>Go</button><button id="other" @click={other}>Other</button></div>
<logic>
let count = 0;
function loaded() { return true; }
${logic}
</logic>`,
    props
  );
  await until(() => container.querySelector('#count')?.textContent === '0', 'the script has loaded');
}

async function press(id: string): Promise<void> {
  await act(async () => {
    container.querySelector<HTMLElement>(`#${id}`)!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('a failure after the app has started', () => {
  it('says what failed and where, and leaves the app running', async () => {
    await app('function go() { count = count + 1; throw new Error("the sum is off"); } function other() { count = 10; }');
    await press('go');
    await until(() => notices().length > 0, 'a bar');
    expect(notices()[0].textContent).toContain('failed in go');
    expect(notices()[0].textContent).toContain('the sum is off');
    await until(() => container.querySelector('#count')?.textContent === '1', 'what it changed before it threw');
    await press('other');
    await until(() => container.querySelector('#count')?.textContent === '10', 'the app still answers');
    expect(console.error).toHaveBeenCalledWith('[SoftN] Error executing function go:', expect.anything());
  });

  it('says a rejection of an async handler, which only the engine sees', async () => {
    await app('async function go() { await null; throw new Error("too late"); } function other() {}');
    await press('go');
    await until(() => notices().length > 0, 'a bar');
    expect(notices()[0].textContent).toContain('failed in go');
    expect(notices()[0].textContent).toContain('too late');
  });

  it('says a timer that fails', async () => {
    await app('function go() { setTimeout(() => { throw new Error("tick"); }, 0); } function other() {}');
    await press('go');
    await until(() => notices().length > 0, 'a bar');
    expect(notices()[0].textContent).toContain('tick');
  });

  it('says a listener on the window that fails', async () => {
    await app('window.addEventListener("keydown", () => { throw new Error("no such key"); }); function go() {} function other() {}');
    for (let i = 0; i < 50 && notices().length === 0; i++) {
      await act(async () => {
        container.querySelector('#go')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    await until(() => notices().length > 0, 'a bar');
    expect(notices()[0].textContent).toContain('a keydown listener');
    expect(notices()[0].textContent).toContain('no such key');
  });

  sandboxed('says a listener on a page written as HTML, which its document catches', async () => {
    await draw(`<button id="go">Go</button><script>document.getElementById("go").addEventListener("click", function () { throw new Error("from the page"); });</script>`);
    await until(() => container.querySelector('#go'), 'the page');
    for (let i = 0; i < 200 && notices().length === 0; i++) await press('go');
    await until(() => notices().length > 0, 'a bar');
    expect(notices()[0].textContent).toContain('a click listener');
    expect(notices()[0].textContent).toContain('from the page');
  });

  sandboxed('says a listener on a page written as HTML has stopped the app', async () => {
    await draw(`<button id="go">Go</button><script>document.getElementById("go").addEventListener("click", function () { while (true) {} });</script>`);
    await until(() => container.querySelector('#go'), 'the page');
    for (let i = 0; i < 200 && notices().length === 0; i++) await press('go');
    await until(() => notices().length > 0, 'a bar');
    expect(notices()[0].textContent).toContain('This app has stopped');
  });

  it('shows one message, the next in place of the last', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    await app('function go() { throw new Error("first"); } function other() { throw new Error("second"); }');
    await press('go');
    await until(() => notices().length > 0, 'a bar');
    now.mockReturnValue(1_002_000);
    await press('other');
    await until(() => notices()[0]?.textContent?.includes('second'), 'the next message');
    expect(notices()).toHaveLength(1);
    expect(notices()[0].textContent).not.toContain('first');
  });

  it('is not flooded by a loop, and stays dismissed', async () => {
    // All in one moment, however long the presses take on a loaded machine.
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await app('function go() { count = count + 1; throw new Error("failure " + count); } function other() {}');
    let drawn = 0;
    const observer = new MutationObserver((changes) => {
      for (const change of changes) drawn += change.addedNodes.length + (change.type === 'characterData' ? 1 : 0);
    });
    await press('go');
    await until(() => notices().length > 0, 'a bar');
    const first = notices()[0].textContent;
    observer.observe(notices()[0], { childList: true, characterData: true, subtree: true });
    for (let i = 0; i < 30; i++) await press('go');
    await until(() => container.querySelector('#count')?.textContent === '31', 'every press ran');
    observer.disconnect();
    // Each message is the script's own and differs from the last, and it stays one line.
    expect(notices()).toHaveLength(1);
    expect(notices()[0].textContent).toBe(first);
    expect(drawn).toBe(0);

    await act(async () => [...notices()[0].querySelectorAll('button')].find((b) => b.textContent === 'Dismiss')!.click());
    expect(notices()).toHaveLength(0);
    for (let i = 0; i < 5; i++) await press('go');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(notices()).toHaveLength(0);
  });

  sandboxed('says the app has stopped when the engine goes with it, and Reload starts it again in place', async () => {
    const reload = vi.fn();
    const location = window.location;
    vi.stubGlobal('location', { ...location, reload, href: location.href, search: '', hash: '', origin: location.origin });
    await app('function go() { count = count + 1; if (count > 1) { while (true) {} } } function other() { count = 10; }');
    await press('go');
    await until(() => container.querySelector('#count')?.textContent === '1', 'the app answers');
    await press('go');
    await until(() => notices().length > 0, 'a bar');
    expect(notices()[0].textContent).toContain('This app has stopped');
    await press('other');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(notices()).toHaveLength(1);
    expect(notices()[0].textContent).toContain('This app has stopped');
    expect(container.querySelector('#count')?.textContent).not.toBe('10');
    // Nothing else says why the app ignores every press, or leads back from it.
    expect([...notices()[0].querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Reload']);

    await act(async () => [...notices()[0].querySelectorAll('button')].find((b) => b.textContent === 'Reload')!.click());
    // A fresh start, as a reload's: what the page held has gone, and a new engine answers.
    await until(() => container.querySelector('#count')?.textContent === '0', 'the app from the start');
    expect(notices()).toHaveLength(0);
    await press('other');
    await until(() => container.querySelector('#count')?.textContent === '10', 'a new engine');
    // Not the host's page, which in SoftN Web is every other app running beside this one.
    expect(reload).not.toHaveBeenCalled();
  }, 60_000);

  it('is left to an editor that says so itself', async () => {
    await app('function go() { throw new Error("listed elsewhere"); } function other() {}', { failureNotices: false });
    await press('go');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(notices()).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith('[SoftN] Error executing function go:', expect.anything());
  });
});

describe('a save the browser refused', () => {
  const saves = () => [...container.querySelectorAll('[data-softn-notice="persistence"]')];
  const dismissSave = () => act(async () => [...saves()[0].querySelectorAll('button')].find((b) => b.textContent === 'Dismiss')!.click());
  const SAVING = 'function go() { count = count + 1; try { localStorage.setItem("best", String(count)); } catch (e) {} } function other() { try { localStorage.setItem("board", "x"); } catch (e) {} }';

  it('is said once for a key, however often the app saves it', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Over quota', 'QuotaExceededError');
    });
    await app(SAVING);
    await press('go');
    await until(() => saves().length > 0, 'a bar');
    expect(saves()[0].textContent).toContain('could not save "best" (QuotaExceededError)');
    expect(saves()[0].textContent).toContain('free up storage');
    await dismissSave();
    for (let i = 0; i < 5; i++) await press('go');
    await until(() => container.querySelector('#count')?.textContent === '6', 'every press ran');
    expect(saves()).toHaveLength(0);
    // Another key is another thing lost.
    await press('other');
    await until(() => saves().length > 0, 'the other key');
    expect(saves()[0].textContent).toContain('could not save "board"');
  });

  it('does not tell a person to free up storage when room is not what is missing', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    await app(SAVING);
    await press('go');
    await until(() => saves().length > 0, 'a bar');
    expect(saves()[0].textContent).toContain('refusing this site\'s storage');
    expect(saves()[0].textContent).not.toContain('free up storage');
  });

  it('leaves it to the store\'s own notice when the browser refuses site data altogether', async () => {
    const real = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
    // As Firefox refuses it, with cookies blocked: the property itself throws.
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    try {
      await app(SAVING);
      await press('go');
      await until(() => container.querySelector('#count')?.textContent === '1', 'the press ran');
      await press('other');
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(saves()).toHaveLength(0);
    } finally {
      Object.defineProperty(window, 'localStorage', real);
    }
  });
});

describe('a page the parser could not read', () => {
  const BROKEN = '<div><p class="shown">drawn all the same</p><p>{1 +}</p></div>';

  it('says where, beside what it could draw', async () => {
    const onError = vi.fn();
    const error = vi.fn(() => <p className="stopped">stopped</p>);
    await draw(BROKEN, { onError, error });
    await until(() => notices().length > 0, 'a bar');
    expect(notices()[0].textContent).toContain('line 1, column');
    expect(notices()[0].textContent).toContain('Nothing follows "+"');
    // It keeps drawing, and is not an app that failed to open.
    expect(container.querySelector('.shown')?.textContent).toBe('drawn all the same');
    expect(container.querySelector('.stopped')).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('says it on the page that came out empty', async () => {
    await draw('<App><Text>{a</Text></App>');
    await until(() => notices().length > 0, 'a bar');
    expect(notices()[0].textContent).toContain('Unclosed tag: <Text>');
  });

  it('names the file when the host knows it', async () => {
    await draw(BROKEN, { parseProblem: 'ui/main.ui, line 4, column 2: Nothing follows "+"' });
    await until(() => notices().length > 0, 'a bar');
    expect(notices()[0].textContent).toContain('ui/main.ui, line 4, column 2');
  });

  it('can be dismissed, and does not come back for the same page', async () => {
    await draw(`${BROKEN}\n<logic>\nlet count = 0;\nfunction go() { count = count + 1; }\n</logic>`);
    await until(() => notices().length > 0, 'a bar');
    await act(async () => [...notices()[0].querySelectorAll('button')].find((b) => b.textContent === 'Dismiss')!.click());
    expect(notices()).toHaveLength(0);
  });

  it('is left to an editor that says so itself', async () => {
    await draw(BROKEN, { failureNotices: false });
    await until(() => container.querySelector('.shown'), 'the page');
    expect(notices()).toHaveLength(0);
  });

  it('says nothing of a warning, which stops nothing', async () => {
    const warned = `<data><collection name="tasks" as="items" /></data>
<div><p class="shown">drawn</p></div>
<data>
  <collection name="todos" as="items" />
</data>`;
    expect((parse(warned).diagnostics ?? []).map((d) => d.severity)).toEqual(['warning']);
    await draw(warned);
    await until(() => container.querySelector('.shown'), 'the page');
    expect(notices()).toHaveLength(0);
  });
});
