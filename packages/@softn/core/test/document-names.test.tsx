/**
 * An app's markup cannot stand in for the document's own members.
 *
 * A document answers to the `name` of an image or a form, and its own
 * members give way: with `<img name="createElement">` on the page,
 * `document.createElement` is that image. React draws with it, so the next
 * thing drawn threw and the page emptied, the host's interface included.
 * These elements carry no `name`, from markup or from sanitized HTML.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';
import { sanitizeRichText } from '../src/renderer/sanitize-html';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let root: Root | null = null;
let container: HTMLElement;

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  container?.remove();
});

async function mount(source: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<SoftNRenderer source={source} appId="document-names" scriptExecutionMode="main" />);
  });
  for (let i = 0; i < 60 && !container.querySelector('#drawn'); i++) {
    await act(async () => {
      await sleep(20);
    });
  }
}

describe('markup', () => {
  it('gives an image and a form no name, in any casing, and leaves the document its own members', async () => {
    await mount(
      `<div id="drawn"><img id="a" name="createElement" alt="" /><img id="b" NAME="querySelector" alt="" />` +
        `<form id="c" name="body"><input id="d" name="email" /></form></div>`
    );
    expect(container.querySelector('#a')).not.toBeNull();
    for (const id of ['a', 'b', 'c']) expect(container.querySelector(`#${id}`)?.hasAttribute('name')).toBe(false);
    expect(typeof document.createElement).toBe('function');
    expect(typeof document.querySelector).toBe('function');
    expect(document.body).toBe(document.documentElement.querySelector('body'));
  });

  it('leaves a field its name: a form posts by it and radios group by it', async () => {
    await mount(`<div id="drawn"><input id="d" name="email" /><select id="e" name="plan"><option>a</option></select></div>`);
    expect(container.querySelector('#d')?.getAttribute('name')).toBe('email');
    expect(container.querySelector('#e')?.getAttribute('name')).toBe('plan');
  });
});

describe('sanitized HTML', () => {
  it('gives an image and a form no name either', () => {
    const out = sanitizeRichText('<p><img name="createElement" src="/a.png" alt="x"><IMG NAME="body" src="/b.png"></p><form name="forms"><input name="q"></form>');
    const box = document.createElement('div');
    box.innerHTML = out;
    for (const img of Array.from(box.querySelectorAll('img'))) expect(img.hasAttribute('name')).toBe(false);
    expect(box.querySelector('form')?.hasAttribute('name') ?? false).toBe(false);
    expect(box.querySelectorAll('img')).toHaveLength(2);
    expect(out).not.toContain('createElement');
  });
});
