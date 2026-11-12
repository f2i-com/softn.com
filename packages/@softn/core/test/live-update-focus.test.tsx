/**
 * Where the keyboard is after an open app is handed a newer page.
 *
 * Before a page is drawn again the renderer notes what has the focus, and
 * puts the focus back afterwards. It read the whole document. With the focus
 * in a field of the host's beside the app (an editor's source, a chat box,
 * neither with an id or a name), it fell to its last rule, "the app holds one
 * element of that tag, so that is it", and focused the app's only textarea,
 * input or button. What the person typed next for the host went into the
 * app's field, where the app's own code reads it; Enter pressed the app's
 * button. An app could arrange it with one textarea off screen.
 *
 * Found by review of the runtime's editor, 2026-11-12.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createLiveApp } from '../src/runtime/live-app';
import { drawLivePage, type LivePage } from './helpers/live-page';

let page: LivePage | null = null;
const outside: HTMLElement[] = [];

afterEach(async () => {
  await page?.unmount();
  page = null;
  for (const element of outside.splice(0)) element.remove();
  localStorage.clear();
});

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

/** A field of the host's own, outside the app: no id and no name, as an editor's fields are. */
function hostField(tag: 'textarea' | 'input' | 'button', id?: string): HTMLElement {
  const field = document.createElement(tag);
  field.className = 'host-editor-field';
  if (id) field.id = id;
  document.body.appendChild(field);
  outside.push(field);
  return field;
}

const PAGE = (words: string) =>
  `<div class="app">\n  <h1 id="title">${words}</h1>\n  <textarea class="app-note"></textarea>\n  <input class="app-input" id="shared">\n  <button class="app-button">Delete everything</button>\n</div>`;

const where = () => {
  const active = document.activeElement as HTMLElement;
  return `${active.tagName.toLowerCase()}.${active.className}`;
};

describe('an open app handed a newer page while the focus is the host’s', () => {
  it.each(['textarea', 'input', 'button'] as const)('leaves the focus in a host %s beside the app', async (tag) => {
    const live = createLiveApp();
    page = await drawLivePage({ app: live, source: PAGE('One'), appId: `live-update-focus-${tag}`, scriptExecutionMode: 'main' });
    await page.reads('#title', 'One');

    const field = hostField(tag);
    field.focus();
    if (tag !== 'button') {
      (field as HTMLTextAreaElement).value = 'typed in the host editor';
      (field as HTMLTextAreaElement).setSelectionRange(5, 5);
    }
    expect(document.activeElement).toBe(field);

    const answer = await asked(page, () => live.update({ source: PAGE('Two') }));
    expect(answer.outcome).toBe('updated');
    await page.reads('#title', 'Two');
    expect(where()).toBe(`${tag}.host-editor-field`);
    if (tag !== 'button') expect((field as HTMLTextAreaElement).selectionStart).toBe(5);
  });

  it('does not take a host field for the app’s by an id the app also uses', async () => {
    const live = createLiveApp();
    page = await drawLivePage({ app: live, source: PAGE('One'), appId: 'live-update-focus-id', scriptExecutionMode: 'main' });
    await page.reads('#title', 'One');
    // The host's field is later in the document than the app's of the same id.
    const field = hostField('input', 'shared');
    field.focus();
    await asked(page, () => live.update({ source: PAGE('Two') }));
    await page.reads('#title', 'Two');
    expect(where()).toBe('input.host-editor-field');
  });
});

describe('an open app handed a newer page while the focus is its own', () => {
  it('keeps the focus, and the caret, in the app’s field', async () => {
    const live = createLiveApp();
    page = await drawLivePage({ app: live, source: PAGE('One'), appId: 'live-update-focus-own', scriptExecutionMode: 'main' });
    await page.reads('#title', 'One');
    const note = page.container.querySelector<HTMLTextAreaElement>('.app-note')!;
    note.focus();
    note.value = 'a note in the app';
    note.setSelectionRange(3, 3);

    // A page that draws the field anew (it moves inside another element), so the focus has to be put back.
    const moved = PAGE('Two').replace('<textarea class="app-note"></textarea>', '<section><textarea class="app-note"></textarea></section>');
    const answer = await asked(page, () => live.update({ source: moved }));
    expect(answer.outcome).toBe('updated');
    await page.reads('#title', 'Two');
    expect(where()).toBe('textarea.app-note');
  });

  it('leaves the person where they went, when they left the app while it was drawn', async () => {
    const live = createLiveApp();
    page = await drawLivePage({ app: live, source: PAGE('One'), appId: 'live-update-focus-left', scriptExecutionMode: 'main' });
    await page.reads('#title', 'One');
    page.container.querySelector<HTMLTextAreaElement>('.app-note')!.focus();
    const field = hostField('textarea');
    const pending = asked(page, () => live.update({ source: PAGE('Two') }));
    field.focus();
    await pending;
    await page.reads('#title', 'Two');
    expect(where()).toBe('textarea.host-editor-field');
  });
});
