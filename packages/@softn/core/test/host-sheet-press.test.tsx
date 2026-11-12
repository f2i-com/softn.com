/**
 * What an app's own `window` listeners hear of a press on something of the
 * HOST's that lies over the app (the runtime editor's pick sheet).
 *
 * An app's `window.addEventListener('pointerdown', …)` is a listener on the
 * real window, in the bubble phase, handed every pointer event that reaches
 * it while the app is on screen (window-bridge.ts, key-capture.ts appHears).
 * A host that takes a press for itself therefore keeps it by stopping it at
 * its own element, before it comes up to the window; a host that stops only
 * the click lets the rest of the press through, and a game fires.
 *
 * Both halves are held here: stopped at the host's element, nothing of the
 * press is heard; not stopped, it is. If the bridge ever listened in the
 * capture phase, the first would fail, and every host sheet would leak.
 */
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { drawLivePage, type LivePage } from './helpers/live-page';

let page: LivePage | null = null;
const outside: HTMLElement[] = [];

afterEach(async () => {
  await page?.unmount();
  page = null;
  for (const element of outside.splice(0)) element.remove();
  localStorage.clear();
});

const APP = `<logic>
let downs = 0
let ups = 0
let clicks = 0
let lastX = -1
function _init() {
  window.addEventListener('pointerdown', function (e) { downs = downs + 1; lastX = e.clientX })
  window.addEventListener('pointerup', function (e) { ups = ups + 1 })
  window.addEventListener('click', function (e) { clicks = clicks + 1 })
}
</logic>
<div class="game">
  <span class="downs">{downs}</span>
  <span class="ups">{ups}</span>
  <span class="clicks">{clicks}</span>
  <span class="x">{lastX}</span>
</div>`;

/** Everything of a press, as the editor's pick sheet keeps it (apps/softn-web/src/edit/pickOverlay.ts). */
const PRESS = ['pointerdown', 'mousedown', 'pointermove', 'pointerup', 'mouseup', 'touchstart', 'touchend', 'click', 'dblclick', 'contextmenu'];

/** The host's sheet: an element of its own, outside the app, laid over it. */
function hostSheet(keeps: string[]): HTMLElement {
  const sheet = document.createElement('div');
  sheet.className = 'host-sheet';
  document.body.appendChild(sheet);
  outside.push(sheet);
  for (const type of keeps) sheet.addEventListener(type, (event) => event.stopPropagation());
  return sheet;
}

async function pressOn(sheet: HTMLElement): Promise<Record<string, string | null>> {
  const live = page as LivePage;
  await act(async () => {
    for (const type of ['pointerdown', 'pointerup', 'click']) sheet.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 123, clientY: 45 }));
  });
  for (let i = 0; i < 40; i++) await live.settle(15);
  return { downs: live.text('.downs'), ups: live.text('.ups'), clicks: live.text('.clicks'), x: live.text('.x') };
}

describe('a press on a sheet the host lays over an app', () => {
  it('is not heard by the app, in any part, when the sheet keeps the press to itself', async () => {
    page = await drawLivePage({ source: APP, appId: 'host-sheet-kept', scriptExecutionMode: 'main' });
    await page.reads('.downs', '0');
    expect(await pressOn(hostSheet(PRESS))).toEqual({ downs: '0', ups: '0', clicks: '0', x: '-1' });
  }, 60_000);

  it('is heard, start and release, when the sheet stops its click alone: which is why a sheet stops all of it', async () => {
    page = await drawLivePage({ source: APP, appId: 'host-sheet-click-only', scriptExecutionMode: 'main' });
    await page.reads('.downs', '0');
    expect(await pressOn(hostSheet(['click']))).toEqual({ downs: '1', ups: '1', clicks: '0', x: '123' });
  }, 60_000);
});

/**
 * A host can also say which elements are its own (`data-softn-host`): its
 * bar, its permission bar, an editor beside the app. A press there told the
 * app which of the host's controls was pressed and where, though the host
 * stopped nothing. Marked, it is the host's; a drag that began in the app
 * still hears the pointer over the chrome and hears it let go there.
 */
describe('a press on what the host marks as its own', () => {
  function chrome(): HTMLElement {
    const bar = document.createElement('div');
    bar.setAttribute('data-softn-host', '');
    const button = document.createElement('button');
    button.className = 'host-button';
    bar.appendChild(button);
    document.body.appendChild(bar);
    outside.push(bar);
    return button;
  }

  it('is not heard by the app, though the host stops none of it', async () => {
    page = await drawLivePage({ source: APP, appId: 'host-chrome-press', scriptExecutionMode: 'main' });
    await page.reads('.downs', '0');
    expect(await pressOn(chrome())).toEqual({ downs: '0', ups: '0', clicks: '0', x: '-1' });
  }, 60_000);

  it('is heard where nothing is marked, as a press anywhere on the page always was', async () => {
    page = await drawLivePage({ source: APP, appId: 'host-chrome-unmarked', scriptExecutionMode: 'main' });
    await page.reads('.downs', '0');
    const plain = document.createElement('button');
    document.body.appendChild(plain);
    outside.push(plain);
    expect(await pressOn(plain)).toEqual({ downs: '1', ups: '1', clicks: '1', x: '123' });
  }, 60_000);

  it('hears the end of a drag that began in the app and was let go over the chrome', async () => {
    page = await drawLivePage({ source: APP, appId: 'host-chrome-drag', scriptExecutionMode: 'main' });
    await page.reads('.downs', '0');
    const live = page;
    const inApp = live.container.querySelector('.game')!;
    const button = chrome();
    await act(async () => {
      inApp.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
      button.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 300, clientY: 5 }));
    });
    for (let i = 0; i < 40; i++) await live.settle(15);
    expect({ downs: live.text('.downs'), ups: live.text('.ups') }).toEqual({ downs: '1', ups: '1' });
    // The drag is over: the next press on the chrome is the host's again.
    expect(await pressOn(button)).toEqual({ downs: '1', ups: '1', clicks: '0', x: '10' });
  }, 60_000);
});
