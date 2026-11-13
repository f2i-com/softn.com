/**
 * A key aimed at the box a host keeps an app in.
 *
 * SoftN Web rests the focus on an app's own tab (a focusable box round the
 * app) so there is somewhere for it to land other than the page. `appHears`
 * (runtime/key-capture.ts) knew the page as a place a key for the app may be
 * aimed at, and no other box: a game's `window.addEventListener('keydown', …)`
 * and `softn.input.captureKeys` heard nothing until the person had clicked one
 * of the app's own controls, and in a browser where a click gives a button no
 * focus (Safari), never. Found by a run of a small game in three browsers,
 * 2026-11-13: 0 of 4 keys heard as the app opened, 4 of 4 with the focus on a
 * button of the app.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { appHears, lastPressWasFor, setAppElement } from '../src/runtime/key-capture';

const made: HTMLElement[] = [];
const owners: object[] = [];

afterEach(() => {
  for (const owner of owners.splice(0)) setAppElement(owner, null);
  for (const element of made.splice(0)) element.remove();
});

/** A host's tab holding an app, as SoftN Web draws one: a focusable box round the app's own box. */
function hosted(): { owner: object; tab: HTMLElement; app: HTMLElement; button: HTMLButtonElement } {
  const tab = document.createElement('div');
  tab.tabIndex = -1;
  tab.setAttribute('data-softn-tab', 'a');
  const app = document.createElement('div');
  app.setAttribute('data-softn-app', '');
  const button = document.createElement('button');
  app.appendChild(button);
  tab.appendChild(app);
  document.body.appendChild(tab);
  made.push(tab);
  const owner = {};
  owners.push(owner);
  setAppElement(owner, app);
  return { owner, tab, app, button };
}

function outside<T extends HTMLElement>(element: T): T {
  document.body.appendChild(element);
  made.push(element);
  return element;
}

/** Send `type` to `target` and say whether the app's window listener would be told. */
function heard(owner: object, target: Element, type: string, event?: Event): boolean {
  let answer = false;
  const ask = (seen: Event): void => {
    answer = appHears(owner, seen);
  };
  window.addEventListener(type, ask);
  target.dispatchEvent(event ?? new KeyboardEvent(type, { key: 'ArrowLeft', bubbles: true }));
  window.removeEventListener(type, ask);
  return answer;
}

describe('a key aimed at the box that holds the app', () => {
  it('is the app’s: on its tab, as on its own controls and on the page', () => {
    const { owner, tab, app, button } = hosted();
    for (const type of ['keydown', 'keyup']) {
      expect(heard(owner, tab, type), `${type} on the tab`).toBe(true);
      expect(heard(owner, button, type), `${type} on the app’s button`).toBe(true);
      expect(heard(owner, app, type), `${type} on the app’s box`).toBe(true);
      expect(heard(owner, document.body, type), `${type} on the page`).toBe(true);
    }
  });

  it('is not the app’s on a control of the host’s beside it, in a field, or on marked chrome', () => {
    const { owner, tab } = hosted();
    const beside = outside(document.createElement('button'));
    const field = outside(document.createElement('input'));
    const bar = outside(document.createElement('div'));
    bar.setAttribute('data-softn-host', '');
    const inBar = document.createElement('button');
    bar.appendChild(inBar);
    expect(heard(owner, beside, 'keydown')).toBe(false);
    expect(heard(owner, field, 'keydown')).toBe(false);
    expect(heard(owner, inBar, 'keydown')).toBe(false);
    // A button of the host's inside the app's tab, beside the app: not a box that holds it.
    const inTab = document.createElement('button');
    tab.appendChild(inTab);
    expect(heard(owner, inTab, 'keydown')).toBe(false);
  });

  it('is not the app’s when the box that holds it is the host’s marked chrome, or is being typed in', () => {
    const marked = hosted();
    marked.tab.setAttribute('data-softn-host', '');
    expect(heard(marked.owner, marked.tab, 'keydown')).toBe(false);
    const typed = hosted();
    // jsdom does not work out isContentEditable from the attribute, so it is said outright.
    typed.tab.setAttribute('contenteditable', 'true');
    Object.defineProperty(typed.tab, 'isContentEditable', { value: true });
    expect(heard(typed.owner, typed.tab, 'keydown')).toBe(false);
  });

  it('is told to the app in that box and to no other app', () => {
    const one = hosted();
    const two = hosted();
    expect(heard(one.owner, one.tab, 'keydown')).toBe(true);
    expect(heard(two.owner, one.tab, 'keydown')).toBe(false);
    // A box that holds both (a page showing two apps side by side) is both apps’, as the page is.
    const both = outside(document.createElement('div'));
    both.append(one.tab, two.tab);
    expect(heard(one.owner, both, 'keydown')).toBe(true);
    expect(heard(two.owner, both, 'keydown')).toBe(true);
  });

  it('changes nothing for the pointer: a press on the tab’s own edge is told as it was', () => {
    const { owner, tab } = hosted();
    const before = heard(owner, tab, 'pointerdown', new MouseEvent('pointerdown', { bubbles: true }));
    expect(before).toBe(true);
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
  });

  it('does not widen what counts as a press for the app (asked before it may write to the clipboard)', () => {
    const { owner, tab, button } = hosted();
    tab.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(lastPressWasFor(owner)).toBe(false);
    button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(lastPressWasFor(owner)).toBe(true);
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
  });
});
