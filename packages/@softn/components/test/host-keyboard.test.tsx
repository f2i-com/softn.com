/**
 * An app's dialog and the host's keyboard.
 *
 * A Modal takes the focus as it opens and keeps Tab and Escape while it is
 * open, by a listener on the document. An app opens one from its logic at any
 * moment. With the person typing in a field of the host's beside the app (a
 * runtime's editor), the keyboard went into the app's dialog, Tab pressed in
 * the host's field was cancelled and pulled into it, and Escape there closed
 * it. Found by review of the runtime's editor, 2026-11-12.
 *
 * The page says what is whose: an app is drawn in `[data-softn-app]`, a
 * host's own controls are in `[data-softn-host]` (utils/hostKeyboard.ts).
 */

import React, { act } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from './dom';
import { Modal } from '../src/feedback/Modal';
import { Confirm } from '../src/feedback/Confirm';
import { isHostsOwn, mayTakeKeyboard } from '../src/utils/hostKeyboard';

beforeEach(() => {
  document.body.innerHTML = '';
});

const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 30)));

function key(target: HTMLElement, name: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/** The app's box with a dialog its logic opened, and the host's editor beside it. */
function page(open: boolean, onClose = () => {}, dialog?: React.ReactElement): React.ReactElement {
  return (
    <>
      <div data-softn-app="a1">
        <button className="in-the-app">An app button</button>
        {dialog ?? (
          <Modal isOpen={open} title="From the app" onClose={onClose}>
            <input className="in-the-apps-dialog" />
          </Modal>
        )}
      </div>
      <aside data-softn-host="">
        <input className="host-field" />
        <button className="host-next">Next host control</button>
      </aside>
      <textarea className="host-plain-field" />
    </>
  );
}

const inApp = (container: HTMLElement) => container.querySelector('[data-softn-app]')!.contains(document.activeElement);

describe('an app’s dialog, with the person in a field of the host’s', () => {
  it.each(['.host-field', '.host-next', '.host-plain-field'])('does not take the keyboard as it opens (focus on %s)', async (selector) => {
    const { container, rerender } = mount(page(false));
    const host = container.querySelector<HTMLElement>(selector)!;
    act(() => host.focus());
    rerender(page(true));
    await settle();
    expect(document.activeElement).toBe(host);
    expect(container.querySelector('.in-the-apps-dialog')).not.toBeNull();
  });

  it('leaves Tab and Escape pressed there to the host', async () => {
    const closed = vi.fn();
    const { container } = mount(page(true, closed));
    await settle();
    const host = container.querySelector<HTMLInputElement>('.host-field')!;
    act(() => host.focus());
    const tab = key(host, 'Tab');
    expect(tab.defaultPrevented).toBe(false);
    expect(inApp(container)).toBe(false);
    key(host, 'Escape');
    expect(closed).not.toHaveBeenCalled();
  });

  it('does not put the focus back in the app when it closes', async () => {
    const { container, rerender } = mount(page(false));
    // The dialog opens while the focus is the app's, and takes it.
    const button = container.querySelector<HTMLElement>('.in-the-app')!;
    act(() => button.focus());
    rerender(page(true));
    await settle();
    expect(inApp(container)).toBe(true);
    // The person goes to the host's field, and the app closes its dialog under them.
    const host = container.querySelector<HTMLInputElement>('.host-field')!;
    act(() => host.focus());
    rerender(page(false));
    await settle();
    expect(document.activeElement).toBe(host);
  });

  it('does not put the keyboard on a question’s answer either', async () => {
    const question = (open: boolean) => page(false, undefined, <Confirm open={open} title="Delete it?" onConfirm={() => {}} onCancel={() => {}} />);
    const { container, rerender } = mount(question(false));
    const host = container.querySelector<HTMLInputElement>('.host-field')!;
    act(() => host.focus());
    rerender(question(true));
    await settle();
    expect(document.activeElement).toBe(host);
  });
});

describe('an app’s dialog, with the focus the app’s or nobody’s', () => {
  it('takes the keyboard as it opens, keeps Tab, and closes on Escape, as before', async () => {
    const closed = vi.fn();
    const { container, rerender } = mount(page(false, closed));
    act(() => container.querySelector<HTMLElement>('.in-the-app')!.focus());
    rerender(page(true, closed));
    await settle();
    expect(inApp(container)).toBe(true);
    const inside = document.activeElement as HTMLElement;
    key(inside, 'Escape');
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('takes it from the page itself', async () => {
    const { container, rerender } = mount(page(false));
    rerender(page(true));
    await settle();
    expect(inApp(container)).toBe(true);
  });
});

describe('a dialog that is not an app’s (these components in a page of one’s own)', () => {
  it('takes the keyboard from a field beside it, as it always did', async () => {
    const standalone = (open: boolean) => (
      <>
        <input className="page-field" />
        <Modal isOpen={open} title="Mine" onClose={() => {}}>
          <input className="in-the-dialog" />
        </Modal>
      </>
    );
    const { container, rerender } = mount(standalone(false));
    const field = container.querySelector<HTMLInputElement>('.page-field')!;
    act(() => field.focus());
    rerender(standalone(true));
    await settle();
    expect(document.activeElement).not.toBe(field);
    expect(container.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true);
  });
});

describe('what is the host’s', () => {
  it('is a field outside every app, or any control in its marked chrome; never the page itself or anything of an app’s', () => {
    const { container } = mount(page(false));
    expect(isHostsOwn(container.querySelector('.host-field'))).toBe(true);
    expect(isHostsOwn(container.querySelector('.host-next'))).toBe(true);
    expect(isHostsOwn(container.querySelector('.host-plain-field'))).toBe(true);
    expect(isHostsOwn(container.querySelector('.in-the-app'))).toBe(false);
    expect(isHostsOwn(document.body)).toBe(false);
    expect(isHostsOwn(null)).toBe(false);
    // A component outside every app is held back by nothing.
    act(() => container.querySelector<HTMLElement>('.host-field')!.focus());
    expect(mayTakeKeyboard(container.querySelector('.host-next'))).toBe(true);
    expect(mayTakeKeyboard(container.querySelector('.in-the-app'))).toBe(false);
  });
});
