/**
 * PixelCanvas.
 *
 * The interesting properties are all invisible from the outside — that the
 * surface is allocated once, that nothing re-renders per frame, that a bad
 * frame leaves the last one alone — so the canvas context is faked and the
 * frame loop is pumped by hand. jsdom has no 2D context of its own, and a real
 * `requestAnimationFrame` would make every assertion a race.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { act } from 'react';
import { mount } from './dom';
import { PixelCanvas } from '../src/utility/PixelCanvas';

interface FakeImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const puts: FakeImageData[] = [];
let created = 0;

beforeAll(() => {
  (HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = function fake() {
    return {
      canvas: this,
      createImageData(w: number, h: number): FakeImageData {
        created += 1;
        return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
      },
      putImageData(image: FakeImageData) {
        puts.push(image);
      },
      clearRect() {},
      fillRect() {},
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      fillStyle: '#000000',
    };
  };

  const frames: FrameRequestCallback[] = [];
  (globalThis as unknown as { __frames: FrameRequestCallback[] }).__frames = frames;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
});

function pump(time: number): void {
  const frames = (globalThis as unknown as { __frames: FrameRequestCallback[] }).__frames;
  const pending = frames.splice(0, frames.length);
  act(() => {
    pending.forEach((cb) => cb(time));
  });
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

describe('PixelCanvas', () => {
  it('expands an indexed frame through the palette prop', () => {
    puts.length = 0;
    const pixels = Uint8Array.from([0, 1, 2, 3]);
    const view = mount(
      <PixelCanvas width={2} height={2} palette={['#ff0000', '#00ff00', [0, 0, 255], 'rgba(0,0,0,0.5)']} frame={b64(pixels)} />,
    );
    expect(puts.length).toBe(1);
    const data = puts[0].data;
    expect([data[0], data[1], data[2], data[3]]).toEqual([255, 0, 0, 255]);
    expect([data[4], data[5], data[6], data[7]]).toEqual([0, 255, 0, 255]);
    expect([data[8], data[9], data[10], data[11]]).toEqual([0, 0, 255, 255]);
    expect(data[15]).toBe(127);
    view.unmount();
  });

  it('copies an rgba frame straight through', () => {
    puts.length = 0;
    const rgba = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const view = mount(<PixelCanvas width={2} height={1} frame={b64(rgba)} />);
    expect(puts.length).toBe(1);
    expect(Array.from(puts[0].data)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    view.unmount();
  });

  it('keeps the previous image when a frame is short or malformed', () => {
    puts.length = 0;
    const good = Uint8Array.from([9, 9, 9, 9]);
    const view = mount(<PixelCanvas width={1} height={1} frame={b64(good)} />);
    expect(puts.length).toBe(1);
    view.rerender(<PixelCanvas width={1} height={1} frame={b64(Uint8Array.from([1, 2]))} />);
    view.rerender(<PixelCanvas width={1} height={1} frame={'!!!!not base64!!!!'} />);
    expect(puts.length).toBe(1);
    expect(Array.from(puts[0].data)).toEqual([9, 9, 9, 9]);
    view.unmount();
  });

  it('drives a getFrame loop, skips unchanged frame numbers, and reports fps', () => {
    puts.length = 0;
    created = 0;
    let renders = 0;
    let counter = 0;
    const fps: number[] = [];
    const pixels = new Uint8Array(4);

    function Host() {
      renders += 1;
      return (
        <PixelCanvas
          width={2}
          height={2}
          getFrame={() => ({
            w: 2,
            h: 2,
            format: 'p8',
            pixels: b64(pixels),
            palette: b64(Uint8Array.from([10, 20, 30, 40, 50, 60])),
            paletteRev: 1,
            frame: counter,
          })}
          onFps={(value) => fps.push(value)}
        />
      );
    }

    const view = mount(<Host />);
    const rendersAtMount = renders;

    counter = 1;
    pump(0);
    expect(puts.length).toBe(1);
    expect(Array.from(puts[0].data.slice(0, 4))).toEqual([10, 20, 30, 255]);

    // Same frame number: no repaint.
    pump(16);
    pump(32);
    expect(puts.length).toBe(1);

    counter = 2;
    pixels[0] = 1;
    pump(48);
    expect(puts.length).toBe(2);
    expect(Array.from(puts[1].data.slice(0, 4))).toEqual([40, 50, 60, 255]);

    // One surface for the whole run, and not one React render per frame.
    expect(created).toBe(1);
    expect(renders).toBe(rendersAtMount);

    counter = 3;
    pump(1200);
    expect(fps.length).toBe(1);
    expect(fps[0]).toBeGreaterThan(0);

    view.unmount();
  });

  it('stops the loop when running is false', () => {
    puts.length = 0;
    let calls = 0;
    const rgba = new Uint8Array(4);
    const view = mount(
      <PixelCanvas
        width={1}
        height={1}
        running={false}
        getFrame={() => {
          calls += 1;
          return b64(rgba);
        }}
      />,
    );
    pump(0);
    expect(calls).toBe(0);
    view.rerender(
      <PixelCanvas
        width={1}
        height={1}
        running
        getFrame={() => {
          calls += 1;
          return b64(rgba);
        }}
      />,
    );
    pump(16);
    expect(calls).toBe(1);
    view.unmount();
  });

  it('survives a getFrame that throws', () => {
    puts.length = 0;
    const view = mount(
      <PixelCanvas
        width={1}
        height={1}
        getFrame={() => {
          throw new Error('boom');
        }}
      />,
    );
    pump(0);
    pump(16);
    expect(puts.length).toBe(0);
    view.unmount();
  });

  it('resizes the surface when a frame changes size', () => {
    puts.length = 0;
    created = 0;
    let size = 2;
    const view = mount(
      <PixelCanvas
        getFrame={() => ({ w: size, h: size, format: 'rgba', pixels: b64(new Uint8Array(size * size * 4)) })}
      />,
    );
    pump(0);
    expect(puts[0].width).toBe(2);
    size = 4;
    pump(16);
    expect(puts[1].width).toBe(4);
    const canvas = view.container.querySelector('canvas') as HTMLCanvasElement;
    expect(canvas.width).toBe(4);
    view.unmount();
  });
});
