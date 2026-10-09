// @vitest-environment jsdom
/**
 * A drag reaches the part of the page that is not on the screen.
 *
 * Held at the lower edge of the canvas with something in hand, the canvas
 * stayed where it was: measured in Chromium, 0 pixels in over a second. A
 * long page could be rearranged only within what one screen showed, or by
 * turning the wheel with the button held.
 */

import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '../stores/canvasStore';
import { EDGE, HOLD_FRAMES, MAX_STEP, edgeScrollStep, useDragAutoScroll } from './dragScroll';

describe('how far the canvas scrolls in a frame', () => {
  const top = 100;
  const bottom = 700;

  it('is nothing while the pointer is in the middle of it', () => {
    for (const y of [top + EDGE, 400, bottom - EDGE]) expect(edgeScrollStep(y, top, bottom)).toBe(0);
  });

  it('is towards the edge the pointer is near, and more the nearer it is', () => {
    expect(edgeScrollStep(bottom - 40, top, bottom)).toBeGreaterThan(0);
    expect(edgeScrollStep(bottom - 5, top, bottom)).toBeGreaterThan(edgeScrollStep(bottom - 40, top, bottom));
    expect(edgeScrollStep(top + 40, top, bottom)).toBeLessThan(0);
    expect(edgeScrollStep(top + 5, top, bottom)).toBeLessThan(edgeScrollStep(top + 40, top, bottom));
  });

  it('is never more than its most, and goes on just past the edge', () => {
    expect(edgeScrollStep(bottom + 20, top, bottom)).toBe(MAX_STEP);
    expect(edgeScrollStep(top - 20, top, bottom)).toBe(-MAX_STEP);
  });

  it('is nothing once the pointer has left the canvas well behind', () => {
    expect(edgeScrollStep(bottom + EDGE + 1, top, bottom)).toBe(0);
    expect(edgeScrollStep(top - EDGE - 1, top, bottom)).toBe(0);
  });

  it('leaves a short canvas a middle that does not scroll', () => {
    expect(edgeScrollStep(50, 0, 100)).toBe(0);
    expect(edgeScrollStep(95, 0, 100)).toBeGreaterThan(0);
  });
});

describe('a drag held near the edge of the canvas', () => {
  let root: Root;
  let host: HTMLDivElement;
  let scroller: HTMLDivElement;
  let frames: FrameRequestCallback[];

  function Harness() {
    const ref = useRef<HTMLDivElement | null>(null);
    useDragAutoScroll(ref);
    return React.createElement('div', { ref, 'data-scroller': true });
  }

  /** Run the frames that are waiting, as a browser would at its next paint. */
  function paint(times = 1): void {
    for (let i = 0; i < times; i += 1) {
      const due = frames;
      frames = [];
      act(() => due.forEach((callback) => callback(0)));
    }
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    useCanvasStore.getState().reset();
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', () => { frames = []; });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(React.createElement(Harness)));
    scroller = host.querySelector<HTMLDivElement>('[data-scroller]')!;
    scroller.getBoundingClientRect = () => ({ top: 100, bottom: 700, left: 300, right: 900, width: 600, height: 600, x: 300, y: 100, toJSON: () => ({}) });
    let scrolled = 0;
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => scrolled, set: (value: number) => { scrolled = Math.max(0, Math.min(1000, value)); } });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  const pointerAt = (x: number, y: number) => act(() => { window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y })); });

  it('scrolls the canvas down, frame after frame, with the pointer still', () => {
    act(() => useCanvasStore.getState().setDraggedType('Card'));
    pointerAt(600, 690);
    paint(HOLD_FRAMES + 3);
    expect(scroller.scrollTop).toBeGreaterThanOrEqual(3 * edgeScrollStep(690, 100, 700));
    const sofar = scroller.scrollTop;
    pointerAt(600, 400);
    paint(3);
    expect(scroller.scrollTop).toBe(sofar);
    pointerAt(600, 104);
    paint(HOLD_FRAMES + 2);
    expect(scroller.scrollTop).toBeLessThan(sofar);
  });

  it('waits a moment at the edge first, so that what is let go there lands where it was aimed', () => {
    act(() => useCanvasStore.getState().setDraggedType('Card'));
    pointerAt(600, 690);
    paint(HOLD_FRAMES - 1);
    expect(scroller.scrollTop).toBe(0);
    // Away from the edge and back: the wait starts again.
    pointerAt(600, 400);
    paint(1);
    pointerAt(600, 690);
    paint(HOLD_FRAMES - 1);
    expect(scroller.scrollTop).toBe(0);
    paint(2);
    expect(scroller.scrollTop).toBeGreaterThan(0);
  });

  it('asks what is under the pointer again after each step, since it has changed', () => {
    const asked: Array<[number, number]> = [];
    const under = document.createElement('div');
    document.body.append(under);
    under.addEventListener('mousemove', (event) => asked.push([event.clientX, event.clientY]));
    document.elementFromPoint = () => under;
    act(() => useCanvasStore.getState().setDraggedType('Card'));
    pointerAt(600, 690);
    paint(HOLD_FRAMES + 2);
    expect(asked).toEqual([[600, 690], [600, 690]]);
    under.remove();
  });

  it('does nothing when nothing is being dragged, or the pointer is beside the canvas', () => {
    pointerAt(600, 690);
    paint(HOLD_FRAMES + 3);
    expect(scroller.scrollTop).toBe(0);
    act(() => useCanvasStore.getState().setDraggedType('Card'));
    pointerAt(120, 690);
    paint(HOLD_FRAMES + 3);
    expect(scroller.scrollTop).toBe(0);
  });

  it('stops when the drag ends', () => {
    act(() => useCanvasStore.getState().setDraggedType('Card'));
    pointerAt(600, 690);
    paint(HOLD_FRAMES + 1);
    const sofar = scroller.scrollTop;
    expect(sofar).toBeGreaterThan(0);
    act(() => useCanvasStore.getState().setDraggedType(null));
    paint(3);
    expect(scroller.scrollTop).toBe(sofar);
  });
});
