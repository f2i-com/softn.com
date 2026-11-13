/**
 * `<Sprite>`: a place, a flip, and named frames.
 *
 * A sprite had a sheet, a row and a speed. It can also be put at `x`, `y`
 * in its container, turned to face the other way with `flipX`, play a list
 * of `frames` instead of the whole row, and with `loop={false}` play them
 * once, stay on the last and say so with `@end`.
 *
 * The screen's clock is stubbed: each `frame(time)` is the screen drawing
 * once at `time` milliseconds, and the frame shown is read off the element.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComponentRegistry, parse, renderDocument, type SoftNComponent, type SoftNRenderContext } from '@softn/core';
import { mount, type Mounted } from './dom';
import { Sprite } from '../src/animation/Sprite';

let pending = new Map<number, (stamp: number) => void>();
let nextHandle = 1;

function frame(time: number): void {
  const due = [...pending.values()];
  pending = new Map();
  act(() => {
    for (const callback of due) callback(time);
  });
}

let mounted: Mounted | null = null;
const sprite = () => mounted!.container.firstElementChild as HTMLElement;
/** The frame on screen, as [column, row] of a sheet of 32-pixel frames. */
const shown = (): [number, number] => {
  const [x, y] = sprite().style.backgroundPosition.split(' ').map((part) => Math.abs(parseFloat(part)) / 32);
  return [x, y];
};

let reducedMotion = false;

beforeEach(() => {
  pending = new Map();
  nextHandle = 1;
  reducedMotion = false;
  vi.stubGlobal('requestAnimationFrame', (callback: (stamp: number) => void) => {
    const handle = nextHandle++;
    pending.set(handle, callback);
    return handle;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    pending.delete(handle);
  });
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: reducedMotion && query.includes('reduce'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
      }) as unknown as MediaQueryList
  );
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a sprite as it was', () => {
  it('plays its row left to right, again and again, in step with the clock', () => {
    mounted = mount(<Sprite src="/hero.png" columns={4} row={2} fps={10} />);
    expect(shown()).toEqual([0, 2]);
    expect(sprite().style.transform).toBe('scale(2)');
    expect(sprite().style.left).toBe('');
    // Ten frames a second: one every 100 ms of the clock.
    const seen: number[] = [];
    for (const time of [100, 200, 300, 400, 500]) {
      frame(time);
      seen.push(shown()[0]);
    }
    expect(seen).toEqual([1, 2, 3, 0, 1]);
    expect(shown()[1]).toBe(2);
  });

  it('holds its first frame while it is not playing', () => {
    mounted = mount(<Sprite src="/hero.png" columns={4} playing={false} />);
    expect(pending.size).toBe(0);
    expect(shown()).toEqual([0, 0]);
  });
});

describe('frames', () => {
  it('plays the frames it is given, in order, instead of the whole row', () => {
    mounted = mount(<Sprite src="/hero.png" columns={8} fps={10} frames={[4, 5, 6]} />);
    // The first of them before the clock has said anything.
    expect(shown()).toEqual([4, 0]);
    const seen: number[] = [];
    for (const time of [100, 200, 300, 400]) {
      frame(time);
      seen.push(shown()[0]);
    }
    expect(seen).toEqual([5, 6, 4, 5]);
  });

  it('counts a frame along the sheet from the first frame of its row, and on to the rows below', () => {
    mounted = mount(<Sprite src="/hero.png" columns={4} row={1} fps={10} frames={[3, 4, 9]} />);
    expect(shown()).toEqual([3, 1]);
    frame(100);
    expect(shown()).toEqual([0, 2]);
    frame(200);
    expect(shown()).toEqual([1, 3]);
  });

  it('does not start over when the page hands it the same frames again', () => {
    const onEnd = vi.fn();
    mounted = mount(<Sprite src="/hero.png" fps={10} frames={[1, 2, 3]} loop={false} onEnd={onEnd} />);
    frame(1000);
    frame(1100);
    expect(shown()[0]).toBe(2);
    // A new list that says the same, as every draw of a page makes.
    mounted.rerender(<Sprite src="/hero.png" fps={10} frames={[1, 2, 3]} loop={false} onEnd={onEnd} />);
    frame(1200);
    expect(shown()[0]).toBe(3);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('holds a list of one frame, and ignores what is not a frame', () => {
    mounted = mount(<Sprite src="/hero.png" fps={10} frames={[6]} />);
    frame(100);
    frame(900);
    expect(shown()).toEqual([6, 0]);
    mounted.rerender(<Sprite src="/hero.png" columns={4} fps={10} frames={[] as number[]} />);
    frame(1100);
    // No frames given: the whole row, as before.
    expect(shown()[0]).toBe(Math.floor(1100 / 100) % 4);
  });
});

describe('loop={false} and @end', () => {
  it('plays once from the first frame, stays on the last, and says so once', () => {
    const onEnd = vi.fn();
    mounted = mount(<Sprite src="/hero.png" fps={10} frames={[4, 5, 6]} loop={false} onEnd={onEnd} />);
    expect(shown()[0]).toBe(4);
    // Whatever the clock reads when it starts, it starts from its first frame.
    frame(5230);
    expect(shown()[0]).toBe(4);
    frame(5330);
    expect(shown()[0]).toBe(5);
    expect(onEnd).not.toHaveBeenCalled();
    frame(5430);
    expect(shown()[0]).toBe(6);
    expect(onEnd).toHaveBeenCalledTimes(1);
    // Over: it asks the screen for nothing more, and stays where it ended.
    expect(pending.size).toBe(0);
    frame(9000);
    expect(shown()[0]).toBe(6);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('plays the whole row once when it is given no frames', () => {
    const onEnd = vi.fn();
    mounted = mount(<Sprite src="/hero.png" columns={3} fps={10} loop={false} onEnd={onEnd} />);
    frame(0);
    frame(100);
    frame(250);
    expect(shown()[0]).toBe(2);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('plays again when its frames change, and when it is turned off and on', () => {
    const onEnd = vi.fn();
    mounted = mount(<Sprite src="/hero.png" fps={10} frames={[4, 5]} loop={false} onEnd={onEnd} />);
    frame(0);
    frame(100);
    expect(onEnd).toHaveBeenCalledTimes(1);

    mounted.rerender(<Sprite src="/hero.png" fps={10} frames={[1, 2]} loop={false} onEnd={onEnd} />);
    expect(shown()[0]).toBe(1);
    frame(700);
    frame(800);
    expect(shown()[0]).toBe(2);
    expect(onEnd).toHaveBeenCalledTimes(2);

    mounted.rerender(<Sprite src="/hero.png" fps={10} frames={[1, 2]} loop={false} playing={false} onEnd={onEnd} />);
    mounted.rerender(<Sprite src="/hero.png" fps={10} frames={[1, 2]} loop={false} onEnd={onEnd} />);
    expect(shown()[0]).toBe(1);
    frame(2000);
    frame(2100);
    expect(onEnd).toHaveBeenCalledTimes(3);
  });

  it('skips falling behind: a slow screen still ends on the last frame', () => {
    const onEnd = vi.fn();
    mounted = mount(<Sprite src="/hero.png" fps={10} frames={[1, 2, 3, 4]} loop={false} onEnd={onEnd} />);
    frame(0);
    frame(2000);
    expect(shown()[0]).toBe(4);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('where the person asked for reduced motion, shows the last frame and says it is over at once', () => {
    reducedMotion = true;
    const onEnd = vi.fn();
    mounted = mount(<Sprite src="/hero.png" fps={10} frames={[4, 5, 6]} loop={false} onEnd={onEnd} />);
    expect(shown()[0]).toBe(6);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(pending.size).toBe(0);
  });

  it('a looping sprite never ends', () => {
    const onEnd = vi.fn();
    mounted = mount(<Sprite src="/hero.png" fps={10} frames={[4, 5]} onEnd={onEnd} />);
    for (let time = 0; time < 1000; time += 100) frame(time);
    expect(onEnd).not.toHaveBeenCalled();
  });
});

describe('x, y and flipX', () => {
  it('puts the sprite at a place in its container, by a transform', () => {
    mounted = mount(<Sprite src="/hero.png" x={120} y={48} scale={3} />);
    const style = sprite().style;
    expect(style.position).toBe('absolute');
    expect([style.left, style.top]).toEqual(['0px', '0px']);
    expect(style.transform).toBe('translate(120px, 48px) scale(3)');
    mounted.rerender(<Sprite src="/hero.png" x={121.5} y={48} scale={3} />);
    expect(sprite().style.transform).toBe('translate(121.5px, 48px) scale(3)');
  });

  it('turns it to face the other way where it stands', () => {
    mounted = mount(<Sprite src="/hero.png" x={100} y={10} frameWidth={32} scale={2} flipX />);
    // Mirrored about its left edge and moved back by its own width (32 × 2).
    expect(sprite().style.transform).toBe('translate(164px, 10px) scale(-2, 2)');
    expect(sprite().style.transformOrigin).toBe('top left');
    // With no place given it turns round in the box it has.
    mounted.rerender(<Sprite src="/hero.png" frameWidth={32} scale={2} flipX />);
    expect(sprite().style.transform).toBe('translate(64px, 0px) scale(-2, 2)');
    expect(sprite().style.left).toBe('');
  });

  it('takes a place of zero as a place', () => {
    mounted = mount(<Sprite src="/hero.png" x={0} y={0} />);
    expect(sprite().style.transform).toBe('translate(0px, 0px) scale(2)');
  });
});

describe('a sprite written in a page', () => {
  const registry = new ComponentRegistry();
  registry.register('Sprite', Sprite as unknown as SoftNComponent);

  it('takes its place, its flip, its frames and @end as a page writes them', () => {
    const source = '<Sprite src="/hero.png" x={x} y={y} flipX={facingLeft} frames={[4, 5, 6]} fps={10} loop={false} @end={landed} />';
    const doc = parse(source);
    expect(doc.diagnostics ?? []).toEqual([]);
    const landed = vi.fn();
    const context = { state: { x: 40, y: 8, facingLeft: true }, setState: () => {}, data: {}, props: {}, computed: {}, functions: { landed }, asyncFunctions: {} } as unknown as SoftNRenderContext;
    mounted = mount(<>{renderDocument(doc, context, registry)}</>);
    expect(sprite().style.transform).toBe('translate(104px, 8px) scale(-2, 2)');
    frame(0);
    frame(100);
    frame(200);
    expect(shown()[0]).toBe(6);
    expect(landed).toHaveBeenCalledTimes(1);
  });
});
