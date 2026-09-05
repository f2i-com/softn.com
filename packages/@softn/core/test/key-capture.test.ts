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
import { sanitizeArgs } from '../src/runtime/vm-args';

function keyOn(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

afterEach(() => clearCapturedKeys());

describe('key capture', () => {
  it('captures nothing until asked, then only the keys named', () => {
    expect(shouldCaptureKey(keyOn(document.body, 'ArrowUp'))).toBe(false);
    setCapturedKeys(['ArrowUp', ' ', 'KeyF']);
    expect(capturedKeyCount()).toBe(3);
    expect(shouldCaptureKey(keyOn(document.body, 'ArrowUp'))).toBe(true);
    expect(shouldCaptureKey(keyOn(document.body, ' '))).toBe(true);
    expect(shouldCaptureKey(keyOn(document.body, 'f', { code: 'KeyF' }))).toBe(true);
    expect(shouldCaptureKey(keyOn(document.body, 'ArrowDown'))).toBe(false);
    clearCapturedKeys();
    expect(shouldCaptureKey(keyOn(document.body, 'ArrowUp'))).toBe(false);
  });

  it('leaves text fields, the system modifier and Ctrl chords to the browser', () => {
    setCapturedKeys(['ArrowUp', 'r', 'Backspace']);
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
