/**
 * `<Controls>`: what the player holds, as one record.
 *
 * The record says each action while a key, a gamepad or a bound DPad holds
 * it, and counts its presses. The component keeps exactly the keys it is
 * given from the browser (so the arrows do not scroll the page), leaves a
 * key typed into a field and the browser's own chords alone, and lets
 * everything go when the window loses focus, when the app or the tab is
 * hidden, and when it is taken off the page.
 *
 * What is bound to one record is one record: an action is held while any
 * key, gamepad button or button on screen holds it, across a `<Controls>`,
 * a `<DPad>` and a second `<Controls>`, and each press is counted once.
 *
 * Driven two ways here: the component alone with a variable held by the
 * test, and from a page with `:bind`, drawn by the real renderer.
 */

import { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppScopeProvider, ComponentRegistry, parse, renderDocument, type AppScope, type SoftNComponent, type SoftNRenderContext } from '@softn/core';
import { mount, type Mounted } from './dom';
import { Controls, type ControlsProps, type ControlsValue } from '../src/utility/Controls';
import { DPad } from '../src/utility/DPad';
import { lazyComponentRegistrations } from '../src/entries/lazy';
import { essentialComponents } from '../src/entries/essentials';
import { builtinComponents } from '../src/registry';

const KEYS = { left: 'ArrowLeft a', right: 'ArrowRight d', fire: 'Space' };

/** A key as a browser sends one: it bubbles from where the focus is, and can be cancelled. */
function key(type: 'keydown' | 'keyup', name: string, code: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent(type, { key: name, code, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function showDocument(shown: boolean): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (shown ? 'visible' : 'hidden') });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** The record as the page's state would hold it, with everything the component did. */
interface Held {
  pad: () => ControlsValue;
  changes: ControlsValue[];
  presses: string[];
  releases: string[];
}

function Bound({ held, extra, ...props }: Partial<ControlsProps> & { held: Held & { set?: (value: ControlsValue) => void }; extra?: React.ReactNode }) {
  const [pad, setPad] = useState<ControlsValue>({ presses: {} });
  held.pad = () => pad;
  held.set = setPad;
  return (
    <>
      <Controls
        keys={KEYS}
        {...props}
        value={pad}
        onChange={(next) => {
          held.changes.push(next);
          setPad(next);
        }}
        onPress={(action) => held.presses.push(action)}
        onRelease={(action) => held.releases.push(action)}
      />
      {extra}
    </>
  );
}

const newHeld = (): Held & { set?: (value: ControlsValue) => void } => ({ pad: () => ({ presses: {} }), changes: [], presses: [], releases: [] });

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

describe('<Controls> and the keyboard', () => {
  it('fills the record in before anything is pressed: every action is there, and every count is a number', () => {
    const held = newHeld();
    mounted = mount(<Bound held={held} />);
    expect(held.pad()).toEqual({ left: false, right: false, fire: false, presses: { left: 0, right: 0, fire: 0 } });
    // Written once, not at every draw.
    expect(held.changes).toHaveLength(1);
  });

  it('says what is held, by any of an action’s keys, and counts each press once', () => {
    const held = newHeld();
    mounted = mount(<Bound held={held} />);
    key('keydown', 'ArrowLeft', 'ArrowLeft');
    expect(held.pad().left).toBe(true);
    expect(held.pad().presses.left).toBe(1);
    // Held down, the keyboard repeats the key: still one press.
    key('keydown', 'ArrowLeft', 'ArrowLeft', { repeat: true });
    key('keydown', 'ArrowLeft', 'ArrowLeft', { repeat: true });
    expect(held.pad().presses.left).toBe(1);
    // The other key of the same action joins it: no new press, and the action
    // is held until both are up.
    key('keydown', 'a', 'KeyA');
    expect(held.pad().presses.left).toBe(1);
    key('keyup', 'ArrowLeft', 'ArrowLeft');
    expect(held.pad().left).toBe(true);
    key('keyup', 'a', 'KeyA');
    expect(held.pad().left).toBe(false);

    key('keydown', ' ', 'Space');
    key('keyup', ' ', 'Space');
    key('keydown', ' ', 'Space');
    expect(held.pad().fire).toBe(true);
    expect(held.pad().presses).toEqual({ left: 1, right: 0, fire: 2 });
    expect(held.presses).toEqual(['left', 'fire', 'fire']);
    expect(held.releases).toEqual(['left', 'fire']);
  });

  it('takes a letter with Shift held as the same key, and lets it go when Shift is let go first', () => {
    const held = newHeld();
    mounted = mount(<Bound held={held} />);
    key('keydown', 'A', 'KeyA', { shiftKey: true });
    expect(held.pad().left).toBe(true);
    // Shift comes up first: the key is called "a" on its way up.
    key('keyup', 'a', 'KeyA');
    expect(held.pad().left).toBe(false);
  });

  it('keeps exactly its keys from the browser, on the way down and on the way up', () => {
    const held = newHeld();
    mounted = mount(<Bound held={held} />);
    expect(key('keydown', 'ArrowLeft', 'ArrowLeft').defaultPrevented).toBe(true);
    expect(key('keydown', 'ArrowLeft', 'ArrowLeft', { repeat: true }).defaultPrevented).toBe(true);
    expect(key('keyup', 'ArrowLeft', 'ArrowLeft').defaultPrevented).toBe(true);
    expect(key('keydown', ' ', 'Space').defaultPrevented).toBe(true);
    // A key it was not given is the page's: the down arrow still scrolls.
    expect(key('keydown', 'ArrowDown', 'ArrowDown').defaultPrevented).toBe(false);
    expect(key('keydown', 'Tab', 'Tab').defaultPrevented).toBe(false);
    expect(held.pad().presses).toEqual({ left: 1, right: 0, fire: 1 });
  });

  it('leaves a key typed into a field to the field, and the browser’s chords to the browser', () => {
    const held = newHeld();
    mounted = mount(<Bound held={held} extra={<input id="name" />} />);
    const field = mounted.container.querySelector('#name') as HTMLInputElement;
    const typed = key('keydown', 'a', 'KeyA', {}, field);
    expect(typed.defaultPrevented).toBe(false);
    expect(held.pad().left).toBe(false);
    expect(key('keydown', ' ', 'Space', {}, field).defaultPrevented).toBe(false);

    // Ctrl+A selects all, Ctrl+D bookmarks, and the system key is the system's.
    expect(key('keydown', 'a', 'KeyA', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key('keydown', 'd', 'KeyD', { metaKey: true }).defaultPrevented).toBe(false);
    expect(held.pad().left).toBe(false);
    expect(held.pad().right).toBe(false);
    expect(held.presses).toEqual([]);
  });

  // Alt+ArrowLeft is the browser's Back. Taken for `left` and cancelled, the
  // page could not be left that way, and the player walked instead.
  it('leaves a key pressed while Alt is held to the browser, on the way down and on the way up', () => {
    const held = newHeld();
    mounted = mount(<Bound held={held} />);
    expect(key('keydown', 'ArrowLeft', 'ArrowLeft', { altKey: true }).defaultPrevented).toBe(false);
    expect(held.pad().left).toBe(false);
    expect(key('keyup', 'ArrowLeft', 'ArrowLeft', { altKey: true }).defaultPrevented).toBe(false);
    expect(key('keydown', ' ', 'Space', { altKey: true }).defaultPrevented).toBe(false);
    expect(held.pad()).toEqual({ left: false, right: false, fire: false, presses: { left: 0, right: 0, fire: 0 } });
    expect(held.presses).toEqual([]);
    // Without Alt it is the game's again.
    expect(key('keydown', 'ArrowLeft', 'ArrowLeft').defaultPrevented).toBe(true);
    expect(held.pad().left).toBe(true);
  });

  it('keeps an action that was held before Alt went down, and lets it go when its key comes up', () => {
    const held = newHeld();
    mounted = mount(<Bound held={held} />);
    key('keydown', 'd', 'KeyD');
    // Alt is not one of this game's keys: it is the browser's, and changes nothing here.
    expect(key('keydown', 'Alt', 'AltLeft', { altKey: true }).defaultPrevented).toBe(false);
    expect(held.pad().right).toBe(true);
    expect(held.releases).toEqual([]);
    // The held key's repeats are Alt chords now: not cancelled, and no new press.
    expect(key('keydown', 'd', 'KeyD', { altKey: true, repeat: true }).defaultPrevented).toBe(false);
    expect(held.pad().presses.right).toBe(1);
    // It comes up with Alt still down: let go, as a key is wherever it comes up.
    key('keyup', 'd', 'KeyD', { altKey: true });
    expect(held.pad().right).toBe(false);
    expect(held.releases).toEqual(['right']);
  });

  it('takes Alt itself where a game names it as a key, as it takes any other', () => {
    const held = newHeld();
    mounted = mount(<Bound held={held} keys={{ run: 'Alt', left: 'ArrowLeft' }} />);
    // The browser says Alt is held on the event of Alt going down.
    expect(key('keydown', 'Alt', 'AltLeft', { altKey: true }).defaultPrevented).toBe(true);
    expect(held.pad().run).toBe(true);
    key('keyup', 'Alt', 'AltLeft');
    expect(held.pad().run).toBe(false);
  });

  // A Mac sends no keyup for a key that is let go while Cmd is held: hold D,
  // press Cmd+S, let go of D, and the player walked on until D was pressed
  // again.
  it('lets go of every key when the system key goes down, and when it comes up', () => {
    const held = newHeld();
    mounted = mount(<Bound held={held} />);
    key('keydown', 'd', 'KeyD');
    key('keydown', ' ', 'Space');
    expect(held.pad()).toMatchObject({ right: true, fire: true });
    key('keydown', 'Meta', 'MetaLeft', { metaKey: true });
    expect(held.pad()).toMatchObject({ right: false, fire: false });
    expect(held.releases.sort()).toEqual(['fire', 'right']);
    // Cmd+S; D and Space are let go meanwhile, and no keyup says so.
    expect(key('keydown', 's', 'KeyS', { metaKey: true }).defaultPrevented).toBe(false);
    key('keyup', 'Meta', 'MetaLeft');
    expect(held.pad()).toMatchObject({ left: false, right: false, fire: false });
    // What was pressed stays counted, and nothing was pressed by any of that.
    expect(held.pad().presses).toEqual({ left: 0, right: 1, fire: 1 });

    // Coming up alone does the same: the system key went down where this
    // window could not hear it.
    key('keydown', 'a', 'KeyA');
    expect(held.pad().left).toBe(true);
    key('keyup', 'Meta', 'MetaRight');
    expect(held.pad().left).toBe(false);
    // The key is pressed again to be held again.
    key('keydown', 'a', 'KeyA');
    expect(held.pad().left).toBe(true);
    expect(held.pad().presses.left).toBe(2);
  });

  // W A S D did nothing on a keyboard set to Russian or Greek: the keys
  // there type other letters, and `event.key` was all that was asked.
  it('takes a letter or a digit by where it usually is, on a keyboard that types something else there', () => {
    const held = newHeld();
    mounted = mount(<Bound held={held} keys={{ up: 'w', left: 'a', one: '1' }} />);
    // Russian: the key where W usually is types the Cyrillic letter tse.
    expect(key('keydown', 'ц', 'KeyW').defaultPrevented).toBe(true);
    expect(held.pad().up).toBe(true);
    key('keyup', 'ц', 'KeyW');
    expect(held.pad().up).toBe(false);
    // Greek, with Shift held: a capital alpha, which is not the Latin A it looks like.
    key('keydown', 'Α', 'KeyA', { shiftKey: true });
    expect(held.pad().left).toBe(true);
    key('keyup', 'α', 'KeyA');
    expect(held.pad().left).toBe(false);
    // A digit key that types a symbol (a French keyboard without Shift, any keyboard with it).
    key('keydown', '&', 'Digit1');
    expect(held.pad().one).toBe(true);
    key('keyup', '&', 'Digit1');
    key('keydown', '!', 'Digit1', { shiftKey: true });
    expect(held.pad().one).toBe(true);
    expect(held.pad().presses).toEqual({ up: 1, left: 1, one: 2 });
  });

  it('still takes a letter by what the key types on a keyboard of Latin letters: a French A is the key that says A', () => {
    const held = newHeld();
    mounted = mount(<Bound held={held} keys={{ up: 'w', left: 'a' }} />);
    // A French keyboard types A from where Q usually is.
    expect(key('keydown', 'a', 'KeyQ').defaultPrevented).toBe(true);
    expect(held.pad().left).toBe(true);
    key('keyup', 'a', 'KeyQ');
    // And Q from where A usually is, Z from where W usually is: neither is this game's.
    expect(key('keydown', 'q', 'KeyA').defaultPrevented).toBe(false);
    expect(key('keydown', 'z', 'KeyW').defaultPrevented).toBe(false);
    expect(held.pad()).toMatchObject({ up: false, left: false });
    // Its W, from where Z usually is.
    key('keydown', 'w', 'KeyZ');
    expect(held.pad().up).toBe(true);
  });

  it('does not take a letter’s usual place where the keyboard types a mark there: its own key is elsewhere', () => {
    const held = newHeld();
    mounted = mount(<Bound held={held} keys={{ map: 'm', up: 'w' }} />);
    // French: the comma is where M usually is, and M is where the semicolon usually is.
    expect(key('keydown', ',', 'KeyM').defaultPrevented).toBe(false);
    expect(held.pad().map).toBe(false);
    key('keyup', ',', 'KeyM');
    key('keydown', 'm', 'Semicolon');
    expect(held.pad().map).toBe(true);
    key('keyup', 'm', 'Semicolon');
    // Dvorak: the comma is where W usually is, and W is where the comma usually is.
    expect(key('keydown', ',', 'KeyW').defaultPrevented).toBe(false);
    expect(held.pad().up).toBe(false);
    key('keyup', ',', 'KeyW');
    key('keydown', 'w', 'Comma');
    expect(held.pad().up).toBe(true);
    // One press each: no key held the action from two places.
    expect(held.pad().presses).toEqual({ map: 1, up: 1 });
  });

  it('takes a key named by its place as that key, whatever it types', () => {
    const held = newHeld();
    mounted = mount(<Bound held={held} keys={{ up: 'KeyW' }} />);
    key('keydown', 'z', 'KeyW');
    expect(held.pad().up).toBe(true);
    key('keyup', 'z', 'KeyW');
    // The key that types W from somewhere else is not the one named.
    expect(key('keydown', 'w', 'KeyZ').defaultPrevented).toBe(false);
    expect(held.pad().up).toBe(false);
  });

  it('lets go of a key that comes up in a field', () => {
    const held = newHeld();
    mounted = mount(<Bound held={held} extra={<input id="name" />} />);
    key('keydown', 'd', 'KeyD');
    expect(held.pad().right).toBe(true);
    key('keyup', 'd', 'KeyD', {}, mounted.container.querySelector('#name')!);
    expect(held.pad().right).toBe(false);
  });

  it('lets everything go when the window loses focus', () => {
    const held = newHeld();
    mounted = mount(<Bound held={held} />);
    key('keydown', 'ArrowRight', 'ArrowRight');
    key('keydown', ' ', 'Space');
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(held.pad()).toMatchObject({ left: false, right: false, fire: false });
    expect(held.releases.sort()).toEqual(['fire', 'right']);
    // The counts are what was pressed, and stay.
    expect(held.pad().presses).toEqual({ left: 0, right: 1, fire: 1 });
  });

  it('lets everything go when the tab is hidden, and when it is turned off', () => {
    const held = newHeld();
    mounted = mount(<Bound held={held} />);
    key('keydown', 'ArrowRight', 'ArrowRight');
    showDocument(false);
    expect(held.pad().right).toBe(false);
    showDocument(true);

    key('keydown', 'ArrowLeft', 'ArrowLeft');
    expect(held.pad().left).toBe(true);
    mounted.rerender(<Bound held={held} enabled={false} />);
    expect(held.pad().left).toBe(false);
    // Turned off, it takes no key: the arrows are the page's again.
    expect(key('keydown', 'ArrowLeft', 'ArrowLeft').defaultPrevented).toBe(false);
    expect(held.pad().left).toBe(false);
  });

  it('hears nothing while the host is showing another app, and lets go of what was held', () => {
    const held = newHeld();
    const inApp = (active: boolean) => (
      <AppScopeProvider value={{ xdb: {} as AppScope['xdb'], active, appId: 'controls-test' }}>
        <Bound held={held} />
      </AppScopeProvider>
    );
    mounted = mount(inApp(true));
    key('keydown', ' ', 'Space');
    expect(held.pad().fire).toBe(true);
    mounted.rerender(inApp(false));
    expect(held.pad().fire).toBe(false);
    // Space pressed in the app on screen is not this game's.
    const other = key('keydown', ' ', 'Space');
    expect(other.defaultPrevented).toBe(false);
    expect(held.pad().presses.fire).toBe(1);
  });

  it('takes only the keys aimed at its own app, where the page holds more than one', () => {
    const held = newHeld();
    mounted = mount(
      <>
        <div data-softn-app="">
          <Bound held={held} extra={<button id="mine">Start</button>} />
        </div>
        <div data-softn-host="">
          <button id="hosts">Publish</button>
        </div>
      </>
    );
    // Space on the host's own button presses that button.
    const onHost = key('keydown', ' ', 'Space', {}, mounted.container.querySelector('#hosts')!);
    expect(onHost.defaultPrevented).toBe(false);
    expect(held.pad().fire).toBe(false);
    // On the app's own button, and on the page with nothing focused, it is the game's.
    expect(key('keydown', ' ', 'Space', {}, mounted.container.querySelector('#mine')!).defaultPrevented).toBe(true);
    key('keyup', ' ', 'Space');
    expect(key('keydown', ' ', 'Space').defaultPrevented).toBe(true);
    expect(held.pad().presses.fire).toBe(2);
  });

  // SoftN Web rests the focus on the box it keeps an app's tab in, which is
  // not the page's body and not one of the app's own elements; the mark the
  // renderer puts round an app draws no box of its own.
  it('takes a key whose focus is on the box the host keeps the app in, and not one in the box of another app', () => {
    const held = newHeld();
    const other = newHeld();
    mounted = mount(
      <>
        <div id="tab-a" tabIndex={-1}>
          <div data-softn-app="" style={{ display: 'contents' }}>
            <div>
              <Bound held={held} />
            </div>
          </div>
        </div>
        <div id="tab-b" tabIndex={-1}>
          <div data-softn-app="" style={{ display: 'contents' }}>
            <div>
              <Bound held={other} />
            </div>
          </div>
        </div>
      </>
    );
    const onTab = key('keydown', 'ArrowLeft', 'ArrowLeft', {}, mounted.container.querySelector('#tab-a')!);
    expect(onTab.defaultPrevented).toBe(true);
    expect(held.pad().left).toBe(true);
    // The other app, whose tab the key was not on, heard nothing.
    expect(other.pad().left).toBe(false);
    key('keyup', 'ArrowLeft', 'ArrowLeft', {}, mounted.container.querySelector('#tab-a')!);
    expect(held.pad().left).toBe(false);
  });

  it('lets everything go when it is taken off the page', () => {
    const held = newHeld();
    const releases: string[] = [];
    const changes: ControlsValue[] = [];
    mounted = mount(<Controls keys={KEYS} value={{ presses: {} }} onChange={(next) => changes.push(next)} onRelease={(action) => releases.push(action)} />);
    void held;
    key('keydown', 'ArrowLeft', 'ArrowLeft');
    mounted.unmount();
    mounted = null;
    expect(releases).toEqual(['left']);
    expect(changes[changes.length - 1].left).toBe(false);
    // And no longer takes the key.
    expect(key('keydown', 'ArrowLeft', 'ArrowLeft').defaultPrevented).toBe(false);
  });

  it('fills in a record that logic put in its place: a new game', () => {
    const held = newHeld();
    mounted = mount(<Bound held={held} />);
    key('keydown', ' ', 'Space');
    key('keyup', ' ', 'Space');
    expect(held.pad().presses.fire).toBe(1);
    act(() => held.set!({ presses: {} }));
    expect(held.pad()).toEqual({ left: false, right: false, fire: false, presses: { left: 0, right: 0, fire: 0 } });
  });

  it('takes its keys as a list as well, and by the names people write', () => {
    const held = newHeld();
    mounted = mount(<Bound held={held} keys={{ jump: ['Space', 'w'], left: 'Left', pause: 'Esc p' }} />);
    key('keydown', 'w', 'KeyW');
    key('keydown', 'ArrowLeft', 'ArrowLeft');
    key('keydown', 'Escape', 'Escape');
    expect(held.pad()).toMatchObject({ jump: true, left: true, pause: true });
  });
});

describe('<Controls> and a gamepad', () => {
  /** The screen's frames, drawn when the test says: a gamepad is read once a frame. */
  let pending: Array<(stamp: number) => void> = [];
  const frame = () => {
    const due = pending;
    pending = [];
    act(() => {
      for (const callback of due) callback(0);
    });
  };
  /** A gamepad on the usual layout: sticks at rest, nothing pressed. */
  const pad = () => ({ connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) });
  let pads: Array<ReturnType<typeof pad> | null> = [];

  beforeEach(() => {
    pending = [];
    pads = [];
    vi.stubGlobal('requestAnimationFrame', (callback: (stamp: number) => void) => pending.push(callback));
    vi.stubGlobal('cancelAnimationFrame', () => {
      pending = [];
    });
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => pads });
  });

  afterEach(() => {
    delete (navigator as unknown as Record<string, unknown>).getGamepads;
  });

  const connect = (gamepad: ReturnType<typeof pad>) => {
    pads = [gamepad];
    act(() => {
      window.dispatchEvent(new Event('gamepadconnected'));
    });
  };

  it('holds the directions with the stick and the d-pad, and the other actions with the buttons in the order they are written', () => {
    const held = newHeld();
    mounted = mount(<Bound held={held} keys={{ left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', fire: 'Space', jump: 'x' }} />);
    const gamepad = pad();
    connect(gamepad);
    frame();
    expect(held.pad()).toMatchObject({ left: false, right: false, fire: false });

    gamepad.axes[0] = -0.9;
    frame();
    expect(held.pad()).toMatchObject({ left: true, right: false });
    // Past the middle, short of the edge: not a direction yet.
    gamepad.axes[0] = 0.2;
    frame();
    expect(held.pad()).toMatchObject({ left: false, right: false });
    gamepad.axes[1] = 0.8;
    gamepad.buttons[15] = { pressed: true, value: 1 };
    frame();
    expect(held.pad()).toMatchObject({ down: true, right: true, up: false });

    gamepad.buttons[0] = { pressed: true, value: 1 };
    frame();
    expect(held.pad().fire).toBe(true);
    gamepad.buttons[0] = { pressed: false, value: 0 };
    gamepad.buttons[1] = { pressed: true, value: 1 };
    frame();
    expect(held.pad()).toMatchObject({ fire: false, jump: true });
    expect(held.pad().presses).toMatchObject({ left: 1, down: 1, right: 1, fire: 1, jump: 1 });
  });

  it('is one with the keyboard: an action held by either is held, and a press is counted once', () => {
    const held = newHeld();
    mounted = mount(<Bound held={held} />);
    const gamepad = pad();
    connect(gamepad);
    key('keydown', ' ', 'Space');
    gamepad.buttons[0] = { pressed: true, value: 1 };
    frame();
    expect(held.pad().presses.fire).toBe(1);
    key('keyup', ' ', 'Space');
    expect(held.pad().fire).toBe(true);
    gamepad.buttons[0] = { pressed: false, value: 0 };
    frame();
    expect(held.pad().fire).toBe(false);
  });

  it('takes the buttons it is told, and none when told false', () => {
    const held = newHeld();
    mounted = mount(<Bound held={held} gamepad={{ fire: [2, 7] }} />);
    const gamepad = pad();
    connect(gamepad);
    gamepad.buttons[0] = { pressed: true, value: 1 };
    frame();
    expect(held.pad().fire).toBe(false);
    gamepad.buttons[7] = { pressed: false, value: 0.9 };
    frame();
    expect(held.pad().fire).toBe(true);

    // Told false with the button still down: nothing reads it coming up, so
    // what it held is let go here. (It stayed held for good.)
    mounted.rerender(<Bound held={held} gamepad={false} />);
    expect(held.pad().fire).toBe(false);
    expect(held.releases).toEqual(['fire']);
    frame();
    expect(held.pad().fire).toBe(false);
    expect(pending).toHaveLength(0);
    // The keyboard is as it was.
    key('keydown', 'ArrowLeft', 'ArrowLeft');
    expect(held.pad().left).toBe(true);
  });

  it('lets go of what the gamepad held when its buttons are named anew, and not when the same ones are said again', () => {
    const held = newHeld();
    mounted = mount(<Bound held={held} gamepad={{ fire: 2 }} />);
    const gamepad = pad();
    connect(gamepad);
    gamepad.buttons[2] = { pressed: true, value: 1 };
    frame();
    expect(held.pad().fire).toBe(true);
    // The page is drawn again and hands over a new object that says the same: nothing changes.
    mounted.rerender(<Bound held={held} gamepad={{ fire: 2 }} />);
    expect(held.pad().fire).toBe(true);
    expect(held.releases).toEqual([]);

    // Button 3 is fire now. Button 2 is still down, and holds nothing.
    mounted.rerender(<Bound held={held} gamepad={{ fire: 3 }} />);
    expect(held.pad().fire).toBe(false);
    expect(held.releases).toEqual(['fire']);
    frame();
    expect(held.pad().fire).toBe(false);
    expect(held.pad().presses.fire).toBe(1);
    gamepad.buttons[3] = { pressed: true, value: 1 };
    frame();
    expect(held.pad().fire).toBe(true);
    expect(held.pad().presses.fire).toBe(2);
  });

  // 0.39, 0.41, 0.39… with one edge at 0.4 was a press at every other frame:
  // ten in twenty frames, each a write of the record and a drawing of the page.
  it('gives the stick two edges: resting at the deadzone it is one press, and it lets go under four fifths of it', () => {
    const held = newHeld();
    mounted = mount(<Bound held={held} keys={{ left: 'ArrowLeft', right: 'ArrowRight' }} />);
    const gamepad = pad();
    connect(gamepad);
    frame();
    const writes = held.changes.length;
    for (let i = 0; i < 20; i++) {
      gamepad.axes[0] = i % 2 === 0 ? 0.41 : 0.39;
      frame();
    }
    expect(held.pad().right).toBe(true);
    expect(held.pad().presses.right).toBe(1);
    expect(held.presses).toEqual(['right']);
    // One write for the press, and none in the nineteen frames after it.
    expect(held.changes.length).toBe(writes + 1);

    // Still over four fifths of the deadzone (0.32): held. Under it: let go.
    gamepad.axes[0] = 0.33;
    frame();
    expect(held.pad().right).toBe(true);
    gamepad.axes[0] = 0.31;
    frame();
    expect(held.pad().right).toBe(false);
    // Let go, it is not held again short of the deadzone itself.
    gamepad.axes[0] = 0.39;
    frame();
    expect(held.pad().right).toBe(false);
    gamepad.axes[0] = 0.41;
    frame();
    expect(held.pad().right).toBe(true);
    expect(held.pad().presses.right).toBe(2);

    // The other way is the other direction's own edge.
    gamepad.axes[0] = -0.41;
    frame();
    expect(held.pad()).toMatchObject({ left: true, right: false });
    gamepad.axes[0] = -0.35;
    frame();
    expect(held.pad().left).toBe(true);
  });

  it('measures the second edge from the deadzone it is given', () => {
    const held = newHeld();
    mounted = mount(<Bound held={held} deadzone={0.5} keys={{ up: 'ArrowUp', down: 'ArrowDown' }} />);
    const gamepad = pad();
    connect(gamepad);
    gamepad.axes[1] = 0.45;
    frame();
    expect(held.pad().down).toBe(false);
    gamepad.axes[1] = 0.55;
    frame();
    expect(held.pad().down).toBe(true);
    gamepad.axes[1] = 0.41;
    frame();
    expect(held.pad().down).toBe(true);
    gamepad.axes[1] = 0.39;
    frame();
    expect(held.pad().down).toBe(false);
  });

  it('keeps what the gamepad holds when the system key lets go of the keyboard', () => {
    const held = newHeld();
    mounted = mount(<Bound held={held} />);
    const gamepad = pad();
    connect(gamepad);
    gamepad.buttons[0] = { pressed: true, value: 1 };
    frame();
    key('keydown', 'd', 'KeyD');
    expect(held.pad()).toMatchObject({ right: true, fire: true });
    key('keydown', 'Meta', 'MetaLeft', { metaKey: true });
    expect(held.pad()).toMatchObject({ right: false, fire: true });
    expect(held.releases).toEqual(['right']);
  });

  it('reads nothing once the gamepad is gone, and lets go of what it held', () => {
    const held = newHeld();
    mounted = mount(<Bound held={held} />);
    const gamepad = pad();
    connect(gamepad);
    gamepad.buttons[0] = { pressed: true, value: 1 };
    frame();
    expect(held.pad().fire).toBe(true);
    pads = [null];
    act(() => {
      window.dispatchEvent(new Event('gamepaddisconnected'));
    });
    frame();
    expect(held.pad().fire).toBe(false);
    // Nothing left to read: it asks for no more frames until one is connected.
    frame();
    expect(pending).toHaveLength(0);
  });
});

describe('a page with <Controls :bind> and <DPad :bind>', () => {
  const registry = new ComponentRegistry();
  registry.registerAll(builtinComponents as unknown as Record<string, SoftNComponent>);

  /** What a test keeps of a page: its state, what `@press` said, how often a component wrote, and a way to write as logic does. */
  interface PageHeld {
    state: Record<string, unknown>;
    heard: string[];
    writes: number;
    put?: (name: string, value: unknown) => void;
  }
  const newPage = (): PageHeld => ({ state: { pad: { presses: {} } }, heard: [], writes: 0 });

  /** A page of `source` whose state is kept and drawn again at each write, as a host keeps it. */
  function Page({ source, held }: { source: string; held: PageHeld }) {
    const [state, setState] = useState<Record<string, unknown>>(held.state);
    held.state = state;
    held.put = (name, value) => setState((before) => ({ ...before, [name]: value }));
    const doc = parse(source);
    const context = {
      state,
      setState: (path: string, value: unknown) => {
        held.writes++;
        setState((before) => ({ ...before, [path]: value }));
      },
      data: {},
      props: {},
      computed: {},
      functions: { heard: (name: unknown) => held.heard.push(String(name)) },
      asyncFunctions: {},
    } as unknown as SoftNRenderContext;
    return <>{renderDocument(doc, context, registry)}</>;
  }

  /** A finger, or the mouse, going down on an element and coming up from it. */
  const point = (type: 'pointerdown' | 'pointerup', target: Element) => {
    act(() => {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    });
  };

  const SOURCE = `<div>
  <Controls :bind={pad} keys={{ left: "ArrowLeft a", right: "ArrowRight d", fire: "Space" }} @press={heard} />
  <DPad :bind={pad} />
  <p id="where">{pad.left ? "left" : pad.right ? "right" : "still"}</p>
</div>`;

  it('parses without a word', () => {
    expect(parse(SOURCE).diagnostics ?? []).toEqual([]);
  });

  it('keeps one record for keys and touch', () => {
    const held = newPage();
    mounted = mount(<Page source={SOURCE} held={held} />);
    const where = () => mounted!.container.querySelector('#where')!.textContent;
    const record = () => held.state.pad as ControlsValue;
    expect(record()).toEqual({ left: false, right: false, fire: false, presses: { left: 0, right: 0, fire: 0 } });

    key('keydown', 'ArrowLeft', 'ArrowLeft');
    expect(where()).toBe('left');
    key('keyup', 'ArrowLeft', 'ArrowLeft');
    expect(where()).toBe('still');

    // The same direction from the pad on screen, in the same record.
    const right = mounted.container.querySelector('button[aria-label="Right"]')!;
    act(() => {
      right.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(where()).toBe('right');
    expect(record().presses).toEqual({ left: 1, right: 1, fire: 0 });
    // What the keyboard holds is still there beside it.
    key('keydown', ' ', 'Space');
    expect(record()).toMatchObject({ right: true, fire: true });
    act(() => {
      right.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    });
    expect(record()).toMatchObject({ right: false, fire: true });
    expect(record().presses).toEqual({ left: 1, right: 1, fire: 1 });
    expect(held.heard).toEqual(['left', 'fire']);

    // The pad's up and down, which the keys were not given, are in it too.
    const up = mounted.container.querySelector('button[aria-label="Up"]')!;
    act(() => {
      up.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(record().up).toBe(true);
    expect(record().presses.up).toBe(1);
  });

  // Each wrote the record from what it had seen itself. With a finger still
  // on the pad's Left, letting go of the Left key wrote `left: false`, and
  // the key going down over the finger counted a second press.
  it('holds an action while a key or the pad holds it, and counts the press once', () => {
    const held = newPage();
    mounted = mount(<Page source={SOURCE} held={held} />);
    const record = () => held.state.pad as ControlsValue;
    const left = mounted.container.querySelector('button[aria-label="Left"]')!;

    // The finger first, the key over it.
    point('pointerdown', left);
    expect(record().left).toBe(true);
    expect(record().presses.left).toBe(1);
    const writes = held.writes;
    key('keydown', 'ArrowLeft', 'ArrowLeft');
    expect(record().left).toBe(true);
    expect(record().presses.left).toBe(1);
    key('keyup', 'ArrowLeft', 'ArrowLeft');
    expect(record().left).toBe(true);
    // Held already and held still: nothing was written, so nothing was drawn again.
    expect(held.writes).toBe(writes);
    expect(held.heard).toEqual([]);
    point('pointerup', left);
    expect(record().left).toBe(false);

    // The key first, the finger over it.
    key('keydown', 'ArrowLeft', 'ArrowLeft');
    expect(record().presses.left).toBe(2);
    point('pointerdown', left);
    expect(record().presses.left).toBe(2);
    point('pointerup', left);
    expect(record().left).toBe(true);
    key('keyup', 'ArrowLeft', 'ArrowLeft');
    expect(record().left).toBe(false);
    expect(held.heard).toEqual(['left']);
    // The record is what the author reads, and nothing more.
    expect(record()).toEqual({ left: false, right: false, fire: false, presses: { left: 2, right: 0, fire: 0 } });
  });

  it('keeps what the pad holds when the system key lets go of the keyboard', () => {
    const held = newPage();
    mounted = mount(<Page source={SOURCE} held={held} />);
    const record = () => held.state.pad as ControlsValue;
    point('pointerdown', mounted.container.querySelector('button[aria-label="Left"]')!);
    key('keydown', 'ArrowLeft', 'ArrowLeft');
    key('keydown', ' ', 'Space');
    key('keydown', 'Meta', 'MetaLeft', { metaKey: true });
    expect(record()).toMatchObject({ left: true, fire: false });
  });

  it('lets go of what a pad held when it is hidden, and not of what a key holds as well', () => {
    const held = newPage();
    held.state = { ...held.state, shown: true };
    mounted = mount(
      <Page
        held={held}
        source={`<div>
  <Controls :bind={pad} keys={{ left: "ArrowLeft", right: "ArrowRight" }} />
  <DPad :bind={pad} visible={shown} />
</div>`}
      />
    );
    const record = () => held.state.pad as ControlsValue;
    point('pointerdown', mounted.container.querySelector('button[aria-label="Left"]')!);
    point('pointerdown', mounted.container.querySelector('button[aria-label="Right"]')!);
    key('keydown', 'ArrowLeft', 'ArrowLeft');
    expect(record()).toMatchObject({ left: true, right: true });
    // The pad is taken away under the fingers.
    act(() => held.put!('shown', false));
    expect(mounted.container.querySelector('button[aria-label="Left"]')).toBeNull();
    expect(record()).toMatchObject({ left: true, right: false });
    key('keyup', 'ArrowLeft', 'ArrowLeft');
    expect(record().left).toBe(false);
  });

  // One key that holds an action in each of two <Controls>: both were handed
  // the same record, each wrote its own change to it, and the second was
  // written over the first.
  it('keeps what each of two <Controls> bound to one record holds', () => {
    const held = newPage();
    mounted = mount(
      <Page
        held={held}
        source={`<div>
  <Controls :bind={pad} keys={{ left: "a ArrowLeft", fire: "Space" }} />
  <Controls :bind={pad} keys={{ strafe: "a", left: "q" }} />
</div>`}
      />
    );
    const record = () => held.state.pad as ControlsValue;
    expect(record()).toEqual({ left: false, fire: false, strafe: false, presses: { left: 0, fire: 0, strafe: 0 } });

    key('keydown', 'a', 'KeyA');
    expect(record()).toMatchObject({ left: true, strafe: true, fire: false });
    expect(record().presses).toEqual({ left: 1, fire: 0, strafe: 1 });
    key('keyup', 'a', 'KeyA');
    expect(record()).toMatchObject({ left: false, strafe: false });

    // An action both name is held while either holds it, and pressed once.
    key('keydown', 'ArrowLeft', 'ArrowLeft');
    key('keydown', 'q', 'KeyQ');
    expect(record().presses.left).toBe(2);
    key('keyup', 'ArrowLeft', 'ArrowLeft');
    expect(record().left).toBe(true);
    key('keyup', 'q', 'KeyQ');
    expect(record().left).toBe(false);
  });

  // Logic writes a record of its own (a new game), and one that logic wrote
  // comes back to the page as a new object: the components are bound to the
  // same variable as before, and still have to know it.
  it('still knows what holds an action when logic puts a new record in the variable', () => {
    const held = newPage();
    mounted = mount(<Page source={SOURCE} held={held} />);
    const record = () => held.state.pad as ControlsValue;
    const left = mounted.container.querySelector('button[aria-label="Left"]')!;
    point('pointerdown', left);
    key('keydown', ' ', 'Space');
    expect(record()).toMatchObject({ left: true, fire: true });

    act(() => held.put!('pad', { presses: {} }));
    // Filled in with what is held now, by the pad as much as by the keys.
    expect(record()).toEqual({ left: true, right: false, fire: true, presses: { left: 0, right: 0, fire: 0 } });
    key('keydown', 'ArrowLeft', 'ArrowLeft');
    expect(record().presses.left).toBe(0);
    key('keyup', 'ArrowLeft', 'ArrowLeft');
    expect(record().left).toBe(true);
    point('pointerup', left);
    expect(record()).toMatchObject({ left: false, fire: true });

    // The same record as a copy, as it comes back from the logic's engine.
    key('keydown', 'ArrowLeft', 'ArrowLeft');
    act(() => held.put!('pad', JSON.parse(JSON.stringify(record()))));
    point('pointerdown', left);
    expect(record().presses.left).toBe(1);
    key('keyup', 'ArrowLeft', 'ArrowLeft');
    expect(record().left).toBe(true);
    point('pointerup', left);
    expect(record().left).toBe(false);
  });
});

describe('<DPad :bind>', () => {
  it('writes each direction while it is held and counts its presses, and still says press and release', () => {
    const changes: Array<Record<string, unknown>> = [];
    const onPress = vi.fn();
    const onRelease = vi.fn();
    function Pad() {
      const [pad, setPad] = useState<Record<string, unknown>>({});
      return (
        <DPad
          value={pad}
          onChange={(next) => {
            changes.push(next);
            setPad(next);
          }}
          onPress={onPress}
          onRelease={onRelease}
        />
      );
    }
    mounted = mount(<Pad />);
    const left = mounted.container.querySelector('button[aria-label="Left"]')!;
    act(() => {
      left.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(changes[changes.length - 1]).toEqual({ left: true, presses: { left: 1 } });
    act(() => {
      left.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    });
    expect(changes[changes.length - 1]).toEqual({ left: false, presses: { left: 1 } });
    act(() => {
      left.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(changes[changes.length - 1]).toEqual({ left: true, presses: { left: 2 } });
    expect(onPress).toHaveBeenCalledTimes(2);
    expect(onRelease).toHaveBeenCalledTimes(1);
    // Taken off the page while held: let go in the record too.
    mounted.unmount();
    mounted = null;
    expect(changes[changes.length - 1]).toEqual({ left: false, presses: { left: 2 } });
  });

  it('unbound, is as it was: it writes nothing', () => {
    const onPress = vi.fn();
    mounted = mount(<DPad onPress={onPress} />);
    act(() => {
      mounted!.container.querySelector('button[aria-label="Up"]')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(onPress).toHaveBeenCalledWith('up');
  });
});

describe('where Controls is registered', () => {
  it('is fetched with the games, on demand, and is not in what every app starts with', () => {
    expect(lazyComponentRegistrations.Controls?.feature).toBe('games');
    expect(lazyComponentRegistrations.Controls?.beforeFirstDraw).toBeUndefined();
    expect(Object.keys(essentialComponents)).not.toContain('Controls');
    expect(Object.keys(essentialComponents)).toContain('Loop');
  });
});
