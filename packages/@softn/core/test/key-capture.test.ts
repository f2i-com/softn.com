/**
 * The keys a script asks the host to keep from the browser: which events
 * the window listeners cancel before forwarding, and which they leave to
 * the browser and to the app's own text fields.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  capturedKeyCount,
  clearCapturedKeys,
  parseCapturedKeys,
  setCapturedKeys,
  shouldCaptureKey,
} from '../src/runtime/key-capture';
import { extractEventProps } from '../src/runtime/event-props';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type ScriptContext,
} from '../src/runtime/script-runtime';
import { sanitizeArgs } from '../src/runtime/vm-args';

function keyOn(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

// The runtimes that asked, as far as these tests are concerned.
const app = {};
const other = {};

afterEach(() => {
  clearCapturedKeys(app);
  clearCapturedKeys(other);
});

describe('key capture', () => {
  it('captures nothing until asked, then only the keys named', () => {
    expect(shouldCaptureKey(keyOn(document.body, 'ArrowUp'))).toBe(false);
    setCapturedKeys(app, ['ArrowUp', ' ', 'KeyF']);
    expect(capturedKeyCount()).toBe(3);
    expect(shouldCaptureKey(keyOn(document.body, 'ArrowUp'))).toBe(true);
    expect(shouldCaptureKey(keyOn(document.body, ' '))).toBe(true);
    expect(shouldCaptureKey(keyOn(document.body, 'f', { code: 'KeyF' }))).toBe(true);
    expect(shouldCaptureKey(keyOn(document.body, 'ArrowDown'))).toBe(false);
    clearCapturedKeys(app);
    expect(shouldCaptureKey(keyOn(document.body, 'ArrowUp'))).toBe(false);
  });

  it('keeps each owner’s keys apart, and captures every owner’s together', () => {
    setCapturedKeys(app, ['ArrowUp', ' ']);
    setCapturedKeys(other, [' ', 'Tab']);
    expect(capturedKeyCount()).toBe(3);
    // Asking again replaces only the asker's own list.
    setCapturedKeys(other, ['Tab']);
    expect(shouldCaptureKey(keyOn(document.body, ' '))).toBe(true);
    expect(shouldCaptureKey(keyOn(document.body, 'Tab'))).toBe(true);
    // Releasing one, by an empty list or by clearing, leaves the other's.
    setCapturedKeys(app, []);
    expect(shouldCaptureKey(keyOn(document.body, 'ArrowUp'))).toBe(false);
    expect(shouldCaptureKey(keyOn(document.body, 'Tab'))).toBe(true);
    setCapturedKeys(app, ['ArrowUp']);
    clearCapturedKeys(other);
    expect(shouldCaptureKey(keyOn(document.body, 'Tab'))).toBe(false);
    expect(shouldCaptureKey(keyOn(document.body, 'ArrowUp'))).toBe(true);
    expect(capturedKeyCount()).toBe(1);
  });

  it('leaves text fields, the system modifier and Ctrl chords to the browser', () => {
    setCapturedKeys(app, ['ArrowUp', 'r', 'Backspace']);
    const input = document.createElement('input');
    const area = document.createElement('textarea');
    const editable = document.createElement('div');
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(shouldCaptureKey(keyOn(input, 'ArrowUp'))).toBe(false);
    expect(shouldCaptureKey(keyOn(area, 'Backspace'))).toBe(false);
    expect(shouldCaptureKey(keyOn(editable, 'Backspace'))).toBe(false);
    expect(shouldCaptureKey(keyOn(document.body, 'Backspace'))).toBe(true);
    expect(shouldCaptureKey(keyOn(document.body, 'ArrowUp', { metaKey: true }))).toBe(false);
    expect(shouldCaptureKey(keyOn(document.body, 'r', { ctrlKey: true }))).toBe(false);
    expect(shouldCaptureKey(keyOn(document.body, 'ArrowUp', { ctrlKey: true }))).toBe(true);
    expect(shouldCaptureKey(new MouseEvent('click'))).toBe(false);
  });

  it('reads the list a host call carries in either spelling', () => {
    expect(parseCapturedKeys('["ArrowUp"," "]')).toEqual(['ArrowUp', ' ']);
    expect(parseCapturedKeys('ArrowUp, Tab ,F1')).toEqual(['ArrowUp', 'Tab', 'F1']);
    expect(parseCapturedKeys(['a', 1])).toEqual(['a', '1']);
    expect(parseCapturedKeys('[not json')).toEqual([]);
    expect(parseCapturedKeys(42)).toEqual([]);
    expect(parseCapturedKeys('')).toEqual([]);
  });
});

describe('key capture with two apps on one page', () => {
  // Studio's preview beside another app, or an app reloaded while the old
  // runtime is still being cleaned up. The captured keys were one list for
  // the page: the second app's list replaced the first's, and the first to
  // close released the other's as well.
  /** An app listening for keys on the window, which captures `key` if it is given one. */
  async function openApp(key?: string) {
    const state: Record<string, unknown> = {};
    const context: ScriptContext = {
      state,
      setState: (path: string, value: unknown) => {
        state[path] = value;
      },
      data: {},
      xdb: createMockXDBModule(),
      nav: createMockNavModule(),
      console: createConsoleModule(),
    };
    const runtime = createScriptRuntime(context);
    const code = `
      let presses = 0
      function grab() {
        window.addEventListener("keydown", function (event) { presses = presses + 1 })
        ${key === undefined ? '' : `softn.input.captureKeys([${JSON.stringify(key)}])`}
      }
    `;
    const loaded = await runtime.loadScript({ type: 'LogicBlock', code, loc: { line: 1, column: 0, start: 0, end: code.length } });
    await loaded.functions.grab();
    return runtime;
  }

  /** Whether a press of `key` on the page has its browser default cancelled. */
  function kept(key: string): boolean {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    return event.defaultPrevented;
  }

  it('keeps each app’s keys until that app closes', async () => {
    const first = await openApp('ArrowUp');
    const second = await openApp('ArrowDown');
    try {
      expect([kept('ArrowUp'), kept('ArrowDown')]).toEqual([true, true]);
      second.cleanup();
      expect([kept('ArrowUp'), kept('ArrowDown')]).toEqual([true, false]);
    } finally {
      second.cleanup();
      first.cleanup();
    }
    expect(kept('ArrowUp')).toBe(false);
  });

  it('keeps them when an app that captured nothing closes', async () => {
    const first = await openApp('ArrowUp');
    const bystander = await openApp();
    try {
      bystander.cleanup();
      expect(kept('ArrowUp')).toBe(true);
    } finally {
      bystander.cleanup();
      first.cleanup();
    }
  });
});

describe('event properties for a script', () => {
  it('gives a pointer event its target rectangle and buttons', () => {
    const canvas = document.createElement('canvas');
    canvas.getBoundingClientRect = () => ({ left: 10, top: 20, width: 640, height: 400 }) as DOMRect;
    const event = new MouseEvent('pointerdown', { clientX: 330, clientY: 220, button: 2, buttons: 2 });
    Object.defineProperty(event, 'target', { value: canvas });
    const props = extractEventProps(event);
    expect(props.targetTag).toBe('canvas');
    expect(props.clientX).toBe(330);
    expect(props.button).toBe(2);
    expect(props.buttons).toBe(2);
    expect(props.targetLeft).toBe(10);
    expect(props.targetTop).toBe(20);
    expect(props.targetWidth).toBe(640);
    expect(props.targetHeight).toBe(400);
  });

  it('reaches a handler on the main thread as the same shape', () => {
    const event = new KeyboardEvent('keydown', { key: 'x', code: 'KeyX' });
    const [asArg] = sanitizeArgs([event]) as Array<Record<string, unknown>>;
    expect(asArg.key).toBe('x');
    expect(asArg.code).toBe('KeyX');
    const synthetic = { nativeEvent: new MouseEvent('click', { clientX: 5 }), currentTarget: document.body };
    const [fromSynthetic] = sanitizeArgs([synthetic]) as Array<Record<string, unknown>>;
    expect(fromSynthetic.type).toBe('click');
    expect(fromSynthetic.clientX).toBe(5);
  });
});
