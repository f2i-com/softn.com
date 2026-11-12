/**
 * @vitest-environment jsdom
 *
 * The editor for a running app is the runtime's own (src/edit/EditPane.tsx).
 *
 * Pinned here, in the runtime as it is mounted: it is not there until the
 * person presses Edit on the bar, and nothing an app or another page can do
 * brings it up; it is drawn outside the app's box, which is what an app can
 * paint in, read and listen in; opening it writes nothing on the app's page;
 * and an app shown in someone else's page, which has no bar, has no editor.
 * jsdom does no layout, so where it is drawn is pinned as structure; the
 * browser runs measure the rest.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { strToU8, zipSync } from 'fflate';

// The library and the editor's store, as a browser has them: a first change
// to an app opened by a link makes a copy, which is saved there.
vi.mock('idb', () => import('./helpers/fakeIdb'));

import { fakeRows, resetFakeIdb } from './helpers/fakeIdb';
import { resetAppCacheAvailability } from '../src/lib/appCache';
import { resetDraftStore, writeDraft } from '../src/edit/drafts';
import App from '../src/App';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom gaps @softn/components' ThemeProvider trips over on mount.
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

// See openFromUrl.test.ts: fflate needs bytes from its own realm.
const ascii = (text: string) => strToU8(text, true);

// One field of each kind an app's page has one of: where the keyboard would go if the editor lost it to the app.
const BUNDLE = zipSync({
  'manifest.json': ascii(JSON.stringify({ name: 'Plain Page', version: '1.0.0', main: 'ui/main.ui' })),
  'ui/main.ui': ascii(
    '<div class="page">\n  <h1 id="title">Plain</h1>\n  <p class="words">Some words</p>\n  <textarea class="app-note"></textarea>\n  <button class="app-button">Delete everything</button>\n</div>\n'
  ),
});

function serve(): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const href = String(input);
    if (href.includes('demos/index.json')) return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    if (!/\.softn(\?|$)/.test(href)) return { ok: false, status: 503, statusText: 'Service Unavailable', text: async () => '' } as unknown as Response;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      url: href,
      headers: new Headers({ 'content-type': 'application/octet-stream' }),
      body: null,
      arrayBuffer: async () => BUNDLE.slice().buffer,
    } as unknown as Response;
  });
}

let container: HTMLElement;
let root: Root;

async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

async function until(what: () => unknown, label: string, tries = 400): Promise<void> {
  for (let i = 0; i < tries && !what(); i++) await settle(1);
  expect(what(), label).toBeTruthy();
}

async function mountAt(address: string): Promise<void> {
  window.history.replaceState({}, '', address);
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(App));
  });
  await until(() => container.querySelector('.softn-runner-app #title'), 'the app is drawn');
}

const pane = (): HTMLElement | null => container.querySelector('.softn-edit');
const box = (): HTMLElement => container.querySelector<HTMLElement>('.softn-runner-app')!;
const editButton = (): HTMLButtonElement | null => container.querySelector('.softn-frame-edit');
/** The editor's own field: the code of the file showing. */
const code = (): HTMLTextAreaElement | null => container.querySelector<HTMLTextAreaElement>('.softn-edit textarea');
const status = (): string => container.querySelector('.softn-edit-status [role="status"]')?.textContent ?? '';
const editorButton = (label: string): HTMLButtonElement =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('.softn-edit-bar button')).find((button) => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === label)!;
const menuItems = (): HTMLElement[] => Array.from(container.querySelectorAll<HTMLElement>('.softn-edit-menu-list [role="menuitem"]:not(:disabled)'));
/** Where the keyboard is, in words. */
const focusIs = (): string => {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body) return 'nowhere';
  if (pane()?.contains(active)) return 'in the editor';
  if (container.querySelector('.softn-runner-app')?.contains(active)) return `in the APP: <${active.tagName.toLowerCase()} class="${active.className}">`;
  return `${active.tagName.toLowerCase()}.${active.className}`;
};

/** Type into a React-controlled field as a person does. */
function typeInto(field: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/** A key pressed where the keyboard is. */
async function key(name: string, type: 'keydown' | 'keyup' = 'keydown'): Promise<void> {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true }));
  });
}

/** A press with a pointer, which a click made by the keyboard is not (its `detail` is 0). */
async function press(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  });
}

async function openEditor(): Promise<void> {
  await act(async () => {
    editButton()!.focus();
    editButton()!.click();
  });
  await until(() => code(), 'the editor opened with the app’s source');
}

beforeEach(() => {
  resetFakeIdb();
  resetAppCacheAvailability();
  resetDraftStore();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
  vi.stubGlobal('fetch', serve());
  localStorage.clear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('the editor for a running app', () => {
  it('is not there until the person presses Edit, whatever an app or another page does', async () => {
    await mountAt('/?open=/demos/plain.softn');
    expect(pane()).toBeNull();
    expect(editButton()?.getAttribute('aria-pressed')).toBe('false');

    // What a page can do from outside, and what an app could try from inside its box.
    await act(async () => {
      window.postMessage({ type: 'softn:edit', edit: true }, '*');
      window.dispatchEvent(new CustomEvent('softn:edit'));
      box().dispatchEvent(new CustomEvent('softn:edit', { bubbles: true }));
      box().dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, bubbles: true }));
      window.history.pushState({}, '', `${window.location.pathname}?edit=1&softn-edit=1#edit`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await settle();
    expect(pane()).toBeNull();
    expect(editButton()?.getAttribute('aria-pressed')).toBe('false');
  });

  it('is drawn outside the app’s box, and opening it writes nothing on the app’s page', async () => {
    await mountAt('/?open=/demos/plain.softn');
    const before = box().innerHTML;
    const own = (element: Element) => Object.keys(element).filter((key) => !key.startsWith('__react'));
    const ownBefore = Array.from(box().querySelectorAll('*')).map(own);

    await act(async () => {
      editButton()!.click();
    });
    await until(() => container.querySelector('.softn-edit textarea'), 'the editor opened with the app’s source');
    expect(editButton()?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector<HTMLTextAreaElement>('.softn-edit textarea')!.value).toContain('<h1 id="title">Plain</h1>');

    // Beside the app, not in it: no part of the editor is inside the box the app paints in.
    const editor = pane()!;
    expect(box().contains(editor)).toBe(false);
    expect(editor.contains(box())).toBe(false);
    expect(container.querySelector('[data-softn-tab]')!.contains(editor)).toBe(false);
    expect(box().querySelector('[class*="softn-edit"]')).toBeNull();
    expect(box().style.contain).toBe('paint');
    // What takes a press while picking is the editor's too, and outside the box.
    const sheet = container.querySelector('.softn-edit-sheet');
    expect(sheet).not.toBeNull();
    expect(box().contains(sheet)).toBe(false);

    // The app's page is the page it was: the same markup, and nothing hung on its elements.
    await settle();
    expect(box().innerHTML).toBe(before);
    expect(Array.from(box().querySelectorAll('*')).map(own)).toEqual(ownBefore);

    // Put away, it is gone, and the page is still the page it was.
    await act(async () => {
      editButton()!.click();
    });
    await settle();
    expect(pane()).toBeNull();
    expect(box().innerHTML).toBe(before);
  });

  it('says whose app it is before anything is changed', async () => {
    await mountAt('/?open=/demos/plain.softn');
    await act(async () => {
      editButton()!.click();
    });
    await until(() => container.querySelector('.softn-edit-whose')?.textContent, 'the editor says whose app it is');
    // Opened by a link: someone else's.
    expect(container.querySelector('.softn-edit-whose')!.textContent).toMatch(/someone else/);
    expect(container.querySelector('.softn-edit-whose')!.textContent).toMatch(/your own copy/);
  });

  it('is not offered where the app is shown in someone else’s page', async () => {
    await mountAt('/?open=/demos/plain.softn&embed=1');
    expect(editButton()).toBeNull();
    expect(container.querySelector('.softn-frame-bar')).toBeNull();
    expect(pane()).toBeNull();
  });
});

/** The runtime's own controls that are neither inside the app's box nor inside anything the runtime marks as its own. */
function unmarkedControls(): string[] {
  const app = container.querySelector('.softn-runner-app');
  return Array.from(container.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [role="separator"], [tabindex]'))
    .filter((element) => !app?.contains(element) && !element.closest('[data-softn-host], [data-softn-consent]'))
    // The frame a tab's app is drawn in holds the app's box: it is not marked, because everything of the app's is inside it.
    .filter((element) => !(app && element.contains(app)))
    // What is on screen with the app: not Home's own controls, which are put away while an app is shown.
    .filter((element) => !element.closest('.softn-launcher, [data-softn-home]') && !element.closest('[hidden]'))
    .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).split(' ')[0]}${element.getAttribute('aria-label') ? `[${element.getAttribute('aria-label')}]` : ''}`);
}

describe('the runtime’s own controls, with an app on screen', () => {
  it('are each marked as the runtime’s own or inside something that is: an app listening on its window is told of no press on them', async () => {
    await mountAt('/?open=/demos/plain.softn');
    const withBar = unmarkedControls();
    await openEditor();
    const withEditor = unmarkedControls();
    // The bar folded away: the corner tab that brings it back.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.softn-frame-bar .softn-frame-btn:not(.softn-frame-edit)')!.click();
    });
    await settle(4);
    const barHidden = unmarkedControls();
    expect({ withBar, withEditor, barHidden }).toEqual({ withBar: [], withEditor: [], barHidden: [] });
    expect(container.querySelector('.softn-chrome-peek')?.getAttribute('data-softn-host')).toBe('');
  }, 60_000);
});

describe('the editor, asked to go while another tab’s changes wait on a choice', () => {
  it('stays, says why, and puts the keyboard on the first answer: from its × and from Edit on the bar', async () => {
    await mountAt('/?open=/demos/plain.softn');
    await openEditor();
    // A first change: the person's own copy, with their changes kept beside it.
    await act(async () => {
      typeInto(code()!, code()!.value.replace('>Plain<', '>Plain, mine<'));
    });
    await until(() => container.querySelector('.softn-runner-app #title')?.textContent === 'Plain, mine', 'the app shows the change', 1500);
    await until(() => fakeRows('softn-web-edits', 'drafts').length === 1 && /running as your copy/.test(status()), 'the change is kept beside the copy', 600);
    // Another tab changes the copy too.
    const kept = fakeRows('softn-web-edits', 'drafts')[0] as { origin: string; at: number; files: Record<string, string> };
    const wrote = await writeDraft({ origin: kept.origin, files: { 'ui/main.ui': kept.files['ui/main.ui'].replace('Some words', 'Words from another tab') }, removed: [], by: 'another tab' }, kept.at);
    expect(wrote.kept).toBe(true);
    // The person types on here, and is asked.
    await act(async () => {
      typeInto(code()!, code()!.value.replace('Plain, mine', 'Plain, mine, and more'));
    });
    await until(() => /^This app was changed in another tab/.test(status()), 'the editor asks', 600);
    const choices = (): string[] => Array.from(container.querySelectorAll('.softn-edit-status .softn-edit-btn')).map((button) => button.textContent?.trim() ?? '');
    expect(choices()).toEqual(['Take those changes', 'Keep mine']);

    // Its own ×.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.softn-edit-close')!.click();
    });
    await settle(4);
    expect(pane()).not.toBeNull();
    expect(status()).toMatch(/The editor stays open until you choose: take those changes, or keep yours\./);
    expect((document.activeElement as HTMLElement).textContent?.trim()).toBe('Take those changes');
    // Edit on the bar.
    await act(async () => {
      code()!.focus();
      editButton()!.click();
    });
    await settle(4);
    expect(pane()).not.toBeNull();
    expect(editButton()?.getAttribute('aria-pressed')).toBe('true');
    expect((document.activeElement as HTMLElement).textContent?.trim()).toBe('Take those changes');
    // What was typed since is still in the editor, and nothing of the other tab's was written over.
    expect(code()!.value).toContain('Plain, mine, and more');
    expect((fakeRows('softn-web-edits', 'drafts')[0] as { files: Record<string, string> }).files['ui/main.ui']).toContain('Words from another tab');

    // Answered ("Keep mine": both tabs changed the one file, so the answer decides it), it goes when asked.
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>('.softn-edit-status .softn-edit-btn')[1].click();
    });
    await until(() => container.querySelector('.softn-runner-app #title')?.textContent === 'Plain, mine, and more', 'the app shows what was typed since', 1500);
    await until(() => choices().length === 0 && /^(Updated|Started again)/.test(status()), 'the answer is taken', 600);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.softn-edit-close')!.click();
    });
    await settle(6);
    expect(pane()).toBeNull();
  }, 60_000);
});

describe('the keyboard, while the editor is open', () => {
  it('stays in the editor while a person types in it: the app is drawn again, and its own field does not take the keys', async () => {
    await mountAt('/?open=/demos/plain.softn');
    await openEditor();
    // Before anything is changed, what the menu offers is the app, not an edited one.
    await press(editorButton('More'));
    expect(menuItems()[0].textContent).toBe('Download the app');
    await key('Escape');

    const field = code()!;
    // The field the renderer could mistake for the app's own: it has no id and no name to be told by.
    expect(field.id).toBe('');
    expect(field.getAttribute('name')).toBeNull();
    await act(async () => {
      field.focus();
    });
    expect(document.activeElement).toBe(field);

    // The person types one change, and goes on typing.
    await act(async () => {
      typeInto(field, field.value.replace('>Plain<', '>Plain and edited<'));
    });
    await until(() => container.querySelector('.softn-runner-app #title')?.textContent === 'Plain and edited', 'the app shows the change', 1500);
    await settle(20);
    expect({ where: focusIs(), status: status() }).toEqual({ where: 'in the editor', status: expect.any(String) });
    expect(document.activeElement).toBe(code());

    // The file is marked as changed in words as well as by its dot, and the menu now offers the edited app.
    const current = container.querySelector('.softn-edit-file[aria-current="true"]')!;
    expect(current.textContent).toBe('ui/main.ui, changed');
    expect(current.querySelector('.softn-edit-dot')?.getAttribute('aria-hidden')).toBe('true');
    expect(current.querySelector('[aria-label]')).toBeNull();
    await press(editorButton('More'));
    expect(menuItems()[0].textContent).toBe('Download the edited app');
  }, 60_000);

  it('goes back to Edit on the bar when the editor is closed from the keyboard', async () => {
    await mountAt('/?open=/demos/plain.softn');
    await openEditor();
    const close = container.querySelector<HTMLButtonElement>('.softn-edit-close')!;
    await act(async () => {
      close.focus();
      close.click();
    });
    await settle(10);
    expect(pane()).toBeNull();
    const active = document.activeElement as HTMLElement;
    expect(active === document.body ? 'body (lost)' : `${active.tagName.toLowerCase()}.${active.className}`).toBe('button.softn-frame-btn softn-frame-edit');
  }, 60_000);

  it('goes to Hide bar, not Edit, when the bar is brought back: the control that undoes what was just done', async () => {
    await mountAt('/?open=/demos/plain.softn');
    const hide = container.querySelector<HTMLButtonElement>('.softn-frame-bar [aria-label="Hide bar"]')!;
    // Edit stands before it in the bar, and on a narrow screen is not in the bar at all.
    expect(container.querySelector('.softn-frame-bar .softn-frame-btn')).toBe(editButton());
    await act(async () => {
      hide.click();
    });
    await until(() => container.querySelector('.softn-chrome-peek'), 'the bar is folded away');
    expect(document.activeElement).toBe(container.querySelector('.softn-chrome-peek'));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.softn-chrome-peek')!.click();
    });
    await until(() => container.querySelector('.softn-frame-bar'), 'the bar is back');
    expect((document.activeElement as HTMLElement).getAttribute('aria-label')).toBe('Hide bar');
  }, 60_000);

  it('works the editor’s menu, its new-file form and its edge, and picks the element the caret is in', async () => {
    await mountAt('/?open=/demos/plain.softn');
    await openEditor();

    // The edge between app and editor says how wide the editor is, and within what.
    const grip = container.querySelector('.softn-edit-grip')!;
    expect(grip.getAttribute('role')).toBe('separator');
    const said = (name: string): number => Number(grip.getAttribute(name));
    expect(said('aria-valuemin')).toBe(320);
    expect(said('aria-valuenow')).toBeGreaterThanOrEqual(said('aria-valuemin'));
    expect(said('aria-valuemax')).toBeGreaterThanOrEqual(said('aria-valuemin'));

    // "More" takes the keyboard when it opens, and the arrow keys move in it.
    const more = editorButton('More');
    await act(async () => {
      more.focus();
      more.click();
    });
    const items = menuItems();
    expect(items.length).toBeGreaterThan(2);
    expect(document.activeElement).toBe(items[0]);
    await key('ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    await key('End');
    expect(document.activeElement).toBe(items[items.length - 1]);
    await key('ArrowDown');
    expect(document.activeElement).toBe(items[0]);
    await key('ArrowUp');
    expect(document.activeElement).toBe(items[items.length - 1]);
    await key('Home');
    expect(document.activeElement).toBe(items[0]);
    // Escape puts it away, and the keyboard is back on the button that opened it.
    await key('Escape');
    expect(container.querySelector('.softn-edit-menu-list')).toBeNull();
    expect(document.activeElement).toBe(more);

    // "Add a file" puts the keyboard in the name; put away, the keyboard is back on "More".
    await act(async () => {
      more.click();
    });
    await act(async () => {
      menuItems().find((item) => item.textContent === 'Add a file')!.click();
    });
    await until(() => container.querySelector('.softn-edit-add input'), 'the new-file form');
    expect(document.activeElement).toBe(container.querySelector('.softn-edit-add input'));
    await key('Escape');
    expect(container.querySelector('.softn-edit-add')).toBeNull();
    expect(document.activeElement).toBe(more);

    // Pick, from the keyboard: the element whose lines the caret is in, and the same form as a press on the app opens.
    const field = code()!;
    const caret = field.value.indexOf('Plain') + 2;
    await act(async () => {
      field.focus();
      field.setSelectionRange(caret, caret);
    });
    const pick = editorButton('Pick');
    await act(async () => {
      pick.focus();
      pick.click();
    });
    await until(() => container.querySelector('.softn-edit-pick'), 'the picked element’s form');
    expect(container.querySelector('.softn-edit-pick strong')!.textContent).toBe('<h1>');
    // Not the mode where the next press on the app picks: nothing is waiting on a pointer.
    expect(pick.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('.softn-edit-sheet--picking')).toBeNull();
    // The keyboard is in the form's first field, which holds the element's words.
    await until(() => container.querySelector('.softn-edit-pick')!.contains(document.activeElement), 'the keyboard is in the form');
    expect((document.activeElement as HTMLInputElement).value).toBe('Plain');

    // With the caret in no element, it says what to do, and picks nothing.
    await press(container.querySelector('.softn-edit-pick .softn-edit-btn')!);
    expect(container.querySelector('.softn-edit-pick')).toBeNull();
    await act(async () => {
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
      pick.focus();
      pick.click();
    });
    expect(status()).toMatch(/^Pick from the keyboard takes the element the caret is in/);
    expect(container.querySelector('.softn-edit-pick')).toBeNull();
  }, 60_000);

  it('keeps Escape to itself while an element is being picked: the app is not handed the key, or its release', async () => {
    await mountAt('/?open=/demos/plain.softn');
    await openEditor();
    // The person was typing in the app's own field, and it has the keyboard still.
    const note = container.querySelector<HTMLTextAreaElement>('.softn-runner-app .app-note')!;
    await act(async () => {
      note.focus();
    });
    await press(editorButton('Pick'));
    expect(editorButton('Pick').getAttribute('aria-pressed')).toBe('true');
    await until(() => container.querySelector('.softn-edit-sheet--picking'), 'the sheet is taking presses');

    // Where an app's own listeners are: on its window (the runtime hands those on), and on its elements.
    const heard: string[] = [];
    const onWindow = (event: Event): void => {
      heard.push(`window ${event.type}`);
    };
    const onField = (event: Event): void => {
      heard.push(`field ${event.type}`);
    };
    window.addEventListener('keydown', onWindow);
    window.addEventListener('keyup', onWindow);
    note.addEventListener('keydown', onField);
    note.addEventListener('keyup', onField);
    try {
      await key('Escape');
      await key('Escape', 'keyup');
      expect(heard).toEqual([]);
      expect(editorButton('Pick').getAttribute('aria-pressed')).toBe('false');
      expect(container.querySelector('.softn-edit-sheet--picking')).toBeNull();
      // Picking over, the key is the app's again.
      await key('Escape');
      expect(heard).toEqual(['field keydown', 'window keydown']);
    } finally {
      window.removeEventListener('keydown', onWindow);
      window.removeEventListener('keyup', onWindow);
      note.removeEventListener('keydown', onField);
      note.removeEventListener('keyup', onField);
    }
  }, 60_000);
});
