/**
 * What an app is told of the pointer on the host's own controls, and whose
 * the keyboard is while the person is using them.
 *
 * `appHears` (runtime/key-capture.ts) is asked directly here, where
 * window-bridge asks it: on the window, in the bubble phase. The same rules
 * with a real app's listeners in the engine are in host-sheet-press.test.tsx.
 *
 * Found by review of the runtime's editor, 2026-11-12: a held press was one
 * slot that any release cleared (a second button let go mid-drag cut the drag
 * off; a release's timer could clear the next press; a release the browser
 * swallowed left the chrome open to the app), and an app could take the
 * keyboard out of a host's field whenever it chose, with `autofocus` or a
 * page script's `focus()`.
 */
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { appHears, setAppElement } from '../src/runtime/key-capture';
import { logicEngineIsSandboxed } from '../src/runtime/vm-adapter';
import { drawLivePage, type LivePage } from './helpers/live-page';

let page: LivePage | null = null;
const outside: HTMLElement[] = [];
const owners: object[] = [];

afterEach(async () => {
  await page?.unmount();
  page = null;
  for (const owner of owners.splice(0)) setAppElement(owner, null);
  for (const element of outside.splice(0)) element.remove();
  // Let any release timer run out, so one test's press is not the next one's.
  window.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  localStorage.clear();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function chrome(): { bar: HTMLElement; button: HTMLButtonElement } {
  const bar = document.createElement('div');
  bar.setAttribute('data-softn-host', '');
  const button = document.createElement('button');
  button.className = 'host-button';
  bar.appendChild(button);
  document.body.appendChild(bar);
  outside.push(bar);
  return { bar, button };
}

/** An app registered as drawn in an element of its own. */
function registered(): { owner: object; app: HTMLElement; inside: HTMLElement } {
  const owner = {};
  const app = document.createElement('div');
  const inside = document.createElement('span');
  app.appendChild(inside);
  document.body.appendChild(app);
  outside.push(app);
  owners.push(owner);
  setAppElement(owner, app);
  return { owner, app, inside };
}

/** Dispatch `type` on `target` and say whether the app would be told of it. */
function heard(owner: object, target: Element, type: string, init: MouseEventInit = {}): boolean {
  let answer = false;
  const ask = (event: Event): void => {
    answer = appHears(owner, event);
  };
  window.addEventListener(type, ask);
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, ...init }));
  window.removeEventListener(type, ask);
  return answer;
}

describe('the pointer on what the host marks as its own', () => {
  it('tells the app nothing: a whole press, and the pointer over it', () => {
    const { owner } = registered();
    const { button } = chrome();
    const told: string[] = [];
    for (const type of ['pointerover', 'pointermove', 'mousemove', 'pointerdown', 'mousedown', 'touchstart', 'pointerup', 'mouseup', 'touchend', 'click', 'dblclick', 'contextmenu', 'wheel', 'dragstart', 'drop']) {
      if (heard(owner, button, type)) told.push(type);
    }
    expect(told).toEqual([]);
  });

  it('tells it of no key there either, as before', () => {
    const { owner } = registered();
    const { button } = chrome();
    const told = ['keydown', 'keyup', 'input', 'focusin'].filter((type) => {
      let answer = false;
      const ask = (event: Event): void => {
        answer = appHears(owner, event);
      };
      window.addEventListener(type, ask);
      button.dispatchEvent(new Event(type, { bubbles: true }));
      window.removeEventListener(type, ask);
      return answer;
    });
    expect(told).toEqual([]);
  });

  it('leaves an element the app marks itself the app’s own', () => {
    const { owner, inside } = registered();
    inside.setAttribute('data-softn-host', '');
    expect(heard(owner, inside, 'pointerdown')).toBe(true);
    expect(heard(owner, inside, 'pointerup')).toBe(true);
  });
});

describe('a drag that began in the app', () => {
  it('is heard to its end over the chrome, though another button was pressed and let go on the way', async () => {
    const { owner, inside } = registered();
    const { button } = chrome();
    expect(heard(owner, inside, 'pointerdown', { button: 0, buttons: 1 })).toBe(true);
    expect(heard(owner, inside, 'mousedown', { button: 0, buttons: 1 })).toBe(true);
    // The right button goes down and up while the left is still held: `mouseup` comes for each button.
    expect(heard(owner, inside, 'mousedown', { button: 2, buttons: 3 })).toBe(true);
    expect(heard(owner, inside, 'mouseup', { button: 2, buttons: 1 })).toBe(true);
    await sleep(5);
    const over = heard(owner, button, 'pointermove', { buttons: 1 });
    const up = heard(owner, button, 'pointerup', { button: 0, buttons: 0 });
    expect({ moveOverChromeHeard: over, releaseOverChromeHeard: up }).toEqual({ moveOverChromeHeard: true, releaseOverChromeHeard: true });
  });

  it('is not cut off by the timer of the release before it', async () => {
    const { owner, inside } = registered();
    const { button } = chrome();
    heard(owner, inside, 'pointerdown');
    heard(owner, inside, 'pointerup');
    // The next press begins before that release's timer has run (a busy page hands input over before timers).
    heard(owner, inside, 'pointerdown');
    await sleep(5);
    expect(heard(owner, button, 'pointerup')).toBe(true);
  });

  it('does not open the chrome to the app when its release never comes', async () => {
    const { owner, inside } = registered();
    const { button } = chrome();
    // The release is the browser's to swallow: a context menu, a select's list, a native drag.
    heard(owner, inside, 'pointerdown', { button: 2 });
    await sleep(20);
    const told: string[] = [];
    for (const type of ['pointermove', 'mousemove', 'wheel', 'pointerover']) if (heard(owner, button, type)) told.push(type);
    // Enter on a button of the bar: a click no pointer made.
    if (heard(owner, button, 'click', { detail: 0 })) told.push('click (from the keyboard)');
    // And the next whole press on the chrome is the host's.
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) if (heard(owner, button, type)) told.push(`${type} (the next press)`);
    expect(told).toEqual([]);
  });

  it('ends at its release: the chrome is the host’s again for the press after', async () => {
    const { owner, inside } = registered();
    const { button } = chrome();
    heard(owner, inside, 'pointerdown', { buttons: 1 });
    expect(heard(owner, button, 'pointerup', { buttons: 0 })).toBe(true);
    await sleep(5);
    expect(heard(owner, button, 'pointermove', { buttons: 0 })).toBe(false);
    expect(heard(owner, button, 'pointerdown', { buttons: 1 })).toBe(false);
    expect(heard(owner, button, 'pointerup', { buttons: 0 })).toBe(false);
  });
});

const TRAP = `<logic>
let show = false
function _init() { setTimeout(function () { show = true }, 60) }
function reveal() { show = true }
</logic>
<div class="app">
  <h1 id="title">Trap</h1>
  <button id="reveal" @click={reveal}>Search</button>
  #if (show)
    <input class="trap" autofocus>
  #end
</div>`;

const LATER = TRAP.replace('function _init() { setTimeout(function () { show = true }, 60) }', '');

function hostField(marked: boolean): HTMLTextAreaElement {
  const field = document.createElement('textarea');
  field.className = 'host-editor-field';
  if (marked) {
    const host = document.createElement('aside');
    host.setAttribute('data-softn-host', '');
    host.appendChild(field);
    document.body.appendChild(host);
    outside.push(host);
  } else {
    document.body.appendChild(field);
    outside.push(field);
  }
  return field;
}

const where = () => {
  const active = document.activeElement as HTMLElement;
  return `${active.tagName.toLowerCase()}.${active.className}`;
};

describe('the keyboard, while the person is in a field of the host’s', () => {
  it.each([true, false])('is not taken by a field the app draws with autofocus (host field in marked chrome: %s)', async (marked) => {
    page = await drawLivePage({ source: TRAP, appId: `host-keyboard-autofocus-${marked}`, scriptExecutionMode: 'main' });
    await page.reads('#title', 'Trap');
    const field = hostField(marked);
    field.focus();
    field.value = 'typed for the host';
    field.setSelectionRange(5, 5);
    for (let i = 0; i < 60 && !page.container.querySelector('.trap'); i++) await page.settle(15);
    expect(page.container.querySelector('.trap')).not.toBeNull();
    await page.settle(30);
    expect(where()).toBe('textarea.host-editor-field');
    expect(field.selectionStart).toBe(5);
  }, 60_000);

  it.skipIf(!logicEngineIsSandboxed())('is not taken by a page’s own script calling focus()', async () => {
    const PAGE = `<!DOCTYPE html>
<html>
<body>
  <h1 id="title">Page</h1>
  <input id="trap" class="trap">
  <script>
    setTimeout(function () { document.getElementById('trap').focus(); document.getElementById('title').textContent = 'Asked'; }, 80);
  </script>
</body>
</html>`;
    page = await drawLivePage({ source: PAGE, appId: 'host-keyboard-shell', scriptExecutionMode: 'main' });
    for (let i = 0; i < 200 && !page.container.querySelector('#trap'); i++) await page.settle(15);
    const field = hostField(false);
    field.focus();
    for (let i = 0; i < 200 && page.container.querySelector('#title')?.textContent !== 'Asked'; i++) await page.settle(15);
    expect(page.container.querySelector('#title')?.textContent).toBe('Asked');
    await page.settle(30);
    expect(where()).toBe('textarea.host-editor-field');
  }, 60_000);

  it('goes to the app’s field when the person pressed in the app to ask for it', async () => {
    page = await drawLivePage({ source: LATER, appId: 'host-keyboard-pressed', scriptExecutionMode: 'main' });
    await page.reads('#title', 'Trap');
    const field = hostField(true);
    field.focus();
    const button = page.container.querySelector<HTMLButtonElement>('#reveal')!;
    // A real press: the pointer goes down on the app's button, which takes the focus as a browser gives it, and the click follows.
    await act(async () => {
      button.focus();
      button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    for (let i = 0; i < 60 && !page.container.querySelector('.trap'); i++) await page.settle(15);
    expect(page.container.querySelector('.trap')).not.toBeNull();
    await page.settle(30);
    expect(where()).toBe('input.trap');
  }, 60_000);

  it('is left where a move made for the person puts it: Tab, a screen reader, voice control, find-in-page', async () => {
    // Nothing is done about a focus move once made. An earlier guard put
    // back every move into the app that no key or pointer explained, which
    // is how assistive technology moves the focus.
    page = await drawLivePage({ source: LATER, appId: 'host-keyboard-moved', scriptExecutionMode: 'main' });
    await page.reads('#title', 'Trap');
    const field = hostField(true);
    field.focus();
    await sleep(600);
    const button = page.container.querySelector<HTMLButtonElement>('#reveal')!;
    button.focus();
    await page.settle(30);
    expect(document.activeElement).toBe(button);
  }, 60_000);
});

// An app that asks for the keyboard again and again: a field with autofocus drawn anew several times a second.
const POLLING = `<logic>
let show = false
let tries = 0
function _init() { setInterval(function () { show = !show; tries = tries + 1 }, 40) }
</logic>
<div class="app">
  <h1 id="title">Polling</h1>
  <span class="tries">{tries}</span>
  #if (show)
    <input class="trap" autofocus>
  #end
</div>`;

/** A field of the host's in its marked chrome that keeps Tab for itself, as a code editor does (Tab indents), and counts its blurs. */
function hostEditor(): { field: HTMLTextAreaElement; blurs: () => number } {
  const field = hostField(true);
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') event.preventDefault();
  });
  let blurred = 0;
  field.addEventListener('blur', () => {
    blurred++;
  });
  return { field, blurs: () => blurred };
}

describe('an app that keeps asking for the keyboard', () => {
  it('never has it, the host’s field is never blurred, and a Tab the host’s editor keeps for indenting changes nothing', async () => {
    page = await drawLivePage({ source: POLLING, appId: 'host-keyboard-polling', scriptExecutionMode: 'main' });
    await page.reads('#title', 'Polling');
    const { field, blurs } = hostEditor();
    field.focus();
    for (let i = 0; i < 60 && Number(page.text('.tries')) < 8; i++) await page.settle(15);
    expect({ at: where(), blurs: blurs() }).toEqual({ at: 'textarea.host-editor-field', blurs: 0 });
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    const triesAtTab = Number(page.text('.tries'));
    for (let i = 0; i < 60 && Number(page.text('.tries')) < triesAtTab + 6; i++) await page.settle(15);
    // A blur ends an input method's composition and puts a phone's keyboard away.
    expect({ at: where(), blurs: blurs() }).toEqual({ at: 'textarea.host-editor-field', blurs: 0 });
  }, 60_000);

  it.skipIf(!logicEngineIsSandboxed())('never has it by a page script’s focus() either', async () => {
    const PAGE = `<!DOCTYPE html>
<html>
<body>
  <h1 id="title">Page</h1>
  <input id="trap" class="trap">
  <script>
    var n = 0;
    setInterval(function () { n++; document.getElementById('trap').focus(); document.getElementById('title').textContent = 'Asked ' + n; }, 40);
  </script>
</body>
</html>`;
    page = await drawLivePage({ source: PAGE, appId: 'host-keyboard-shell-polling', scriptExecutionMode: 'main' });
    for (let i = 0; i < 200 && !page.container.querySelector('#trap'); i++) await page.settle(15);
    const { field, blurs } = hostEditor();
    field.focus();
    const count = () => Number((page!.container.querySelector('#title')?.textContent ?? '').replace('Asked ', '')) || 0;
    for (let i = 0; i < 100 && count() < 4; i++) await page.settle(15);
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    const at = count();
    for (let i = 0; i < 100 && count() < at + 3; i++) await page.settle(15);
    expect({ at: where(), blurs: blurs() }).toEqual({ at: 'textarea.host-editor-field', blurs: 0 });
  }, 60_000);
});

describe('an app that is starting', () => {
  // A first change to someone else's app starts it again as the person's copy; Restart and a reopen start it too.
  it.each([
    ['with logic', '<logic>\nlet n = 1\n</logic>\n<div class="app"><h1 id="title">Search</h1><input class="app-search" autofocus></div>'],
    ['with no logic at all', '<div class="app"><h1 id="title">Search</h1><input class="app-search" autofocus></div>'],
  ])('does not take the keyboard with a field drawn with autofocus on its first screen (%s)', async (name, source) => {
    const { field, blurs } = hostEditor();
    field.focus();
    page = await drawLivePage({ source, appId: `host-keyboard-first-screen-${name.length}`, scriptExecutionMode: 'main' });
    await page.reads('#title', 'Search');
    await page.settle(30);
    expect({ at: where(), blurs: blurs() }).toEqual({ at: 'textarea.host-editor-field', blurs: 0 });
  }, 60_000);

  it('has its autofocus when nobody is using anything of the host’s', async () => {
    page = await drawLivePage({ source: '<div class="app"><h1 id="title">Search</h1><input class="app-search" autofocus></div>', appId: 'host-keyboard-free', scriptExecutionMode: 'main' });
    await page.reads('#title', 'Search');
    await page.settle(30);
    expect(where()).toBe('input.app-search');
  }, 60_000);
});

describe('two fingers', () => {
  it('one put on the app while another is on the bar does not make the bar finger’s release the app’s', () => {
    const { owner, inside } = registered();
    const { button } = chrome();
    // Each finger is a pointer of its own, with its own pointerdown: the first is the primary one.
    const first = { isPrimary: true, buttons: 1 } as MouseEventInit;
    const second = { isPrimary: false, buttons: 1 } as MouseEventInit;
    const downOnBar = heardPointer(owner, button, 'pointerdown', first);
    const downInApp = heardPointer(owner, inside, 'pointerdown', second);
    // The bar finger lifts; its events go to the element it went down on.
    const upOnBar = heardPointer(owner, button, 'pointerup', { ...first, buttons: 0 });
    expect({ downOnBar, downInApp, upOnBar }).toEqual({ downOnBar: false, downInApp: true, upOnBar: false });
  });
});

/** As `heard`, with a pointer event that says whether it is the primary pointer (jsdom's MouseEvent does not carry it). */
function heardPointer(owner: object, target: Element, type: string, init: MouseEventInit & { isPrimary?: boolean }): boolean {
  let answer = false;
  const ask = (event: Event): void => {
    answer = appHears(owner, event);
  };
  window.addEventListener(type, ask);
  const event = new MouseEvent(type, { bubbles: true, ...init });
  Object.defineProperty(event, 'isPrimary', { value: init.isPrimary === true });
  target.dispatchEvent(event);
  window.removeEventListener(type, ask);
  return answer;
}
