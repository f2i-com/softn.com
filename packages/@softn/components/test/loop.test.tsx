/**
 * `<Loop>`: a clock for a game.
 *
 * The timer form calls `@tick` every `interval` milliseconds and always
 * has. The frame form (`frame`) calls it once for each frame the screen
 * draws, with the seconds since the last call, never while the last call is
 * still running, at most `maxFps` times a second, and not at all while the
 * app or the browser's tab is hidden: the first tick after it is shown
 * again is handed one frame's time, not the time it was away.
 *
 * Frames are driven by hand here: the screen's clock is stubbed, and each
 * `frame(ms)` is the screen drawing once, `ms` after the last.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppScopeProvider, type AppScope } from '@softn/core';
import { mount, type Mounted } from './dom';
import { Loop } from '../src/utility/Loop';

/** The screen's frames, drawn when the test says. */
let pending = new Map<number, (stamp: number) => void>();
let nextHandle = 1;
let screenTime = 1000;

function frame(ms = 16): void {
  screenTime += ms;
  const due = [...pending.values()];
  pending = new Map();
  act(() => {
    for (const callback of due) callback(screenTime);
  });
}

const flush = () => act(() => Promise.resolve());

function showDocument(shown: boolean): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (shown ? 'visible' : 'hidden') });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

const inApp = (active: boolean, child: React.ReactElement) => (
  <AppScopeProvider value={{ xdb: {} as AppScope['xdb'], active, appId: 'loop-test' }}>{child}</AppScopeProvider>
);

let mounted: Mounted | null = null;

beforeEach(() => {
  pending = new Map();
  nextHandle = 1;
  screenTime = 1000;
  vi.stubGlobal('requestAnimationFrame', (callback: (stamp: number) => void) => {
    const handle = nextHandle++;
    pending.set(handle, callback);
    return handle;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    pending.delete(handle);
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

describe('<Loop frame>', () => {
  it('ticks once for each frame the screen draws, with the seconds since the last', async () => {
    const dts: number[] = [];
    mounted = mount(<Loop frame running onTick={(dt) => void dts.push(dt ?? -1)} />);
    // The first frame only sets the clock: there is no step before it.
    frame(16);
    expect(dts).toEqual([]);
    frame(16);
    await flush();
    frame(20);
    await flush();
    frame(8);
    await flush();
    expect(dts.map((dt) => Math.round(dt * 1000))).toEqual([16, 20, 8]);
  });

  it('does not tick while it is not running, and stops asking for frames', () => {
    const onTick = vi.fn();
    mounted = mount(<Loop frame running={false} onTick={onTick} />);
    expect(pending.size).toBe(0);
    mounted.rerender(<Loop frame running onTick={onTick} />);
    expect(pending.size).toBe(1);
    mounted.rerender(<Loop frame running={false} onTick={onTick} />);
    expect(pending.size).toBe(0);
    frame();
    frame();
    expect(onTick).not.toHaveBeenCalled();
  });

  it('never starts a tick while the last is still running, and hands the next one the longer step', async () => {
    const dts: number[] = [];
    let finish: () => void = () => {};
    const onTick = (dt?: number) => {
      dts.push(dt ?? -1);
      // A tick that takes three frames to answer: logic that is behind.
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    };
    mounted = mount(<Loop frame running onTick={onTick} />);
    frame(16);
    frame(16);
    expect(dts).toHaveLength(1);
    frame(16);
    frame(16);
    frame(16);
    expect(dts).toHaveLength(1);
    await act(async () => {
      finish();
    });
    frame(16);
    expect(dts).toHaveLength(2);
    // The four frames since the tick that was running: 64 ms, not 16.
    expect(Math.round(dts[1] * 1000)).toBe(64);
  });

  it('goes on after a tick that fails', async () => {
    let calls = 0;
    const onTick = () => {
      calls++;
      if (calls === 1) throw new Error('a bad frame');
      if (calls === 2) return Promise.reject(new Error('a worse one'));
      return undefined;
    };
    mounted = mount(<Loop frame running onTick={onTick} />);
    frame();
    for (let i = 0; i < 4; i++) {
      frame();
      await flush();
    }
    expect(calls).toBe(4);
  });

  it('never hands over a step longer than a fifth of a second', async () => {
    const dts: number[] = [];
    mounted = mount(<Loop frame running onTick={(dt) => void dts.push(dt ?? -1)} />);
    frame(16);
    // The screen stalled for three seconds without the page being told it was hidden.
    frame(3000);
    await flush();
    expect(dts).toEqual([0.2]);
  });

  // A browser does not always say a page is hidden: a tab behind another
  // under some hosts, a frame scrolled out of sight, a computer that slept.
  // The frames just stop, and the first one back comes a long time later.
  it('takes a screen that stopped drawing, with no tick running, as not being shown: the first frame back sets the clock', async () => {
    let wall = 5000;
    vi.spyOn(performance, 'now').mockImplementation(() => wall);
    const dts: number[] = [];
    mounted = mount(<Loop frame running onTick={(dt) => void dts.push(dt ?? -1)} />);
    const draw = async (ms: number) => {
      wall += ms;
      frame(ms);
      await flush();
    };
    await draw(16);
    await draw(16);
    await draw(16);
    expect(dts).toHaveLength(2);
    // Three seconds with no frame at all, then the screen draws again.
    await draw(3000);
    expect(dts).toHaveLength(2);
    await draw(16);
    expect(dts).toHaveLength(3);
    expect(Math.round(dts[2] * 1000)).toBe(16);
    // A frame that is merely slow is still a step, of its own length.
    await draw(120);
    expect(Math.round(dts[3] * 1000)).toBe(120);
  });

  it('does not take logic that is behind for a screen that stopped: a tick that ran long is followed by a tick', async () => {
    let wall = 5000;
    vi.spyOn(performance, 'now').mockImplementation(() => wall);
    const dts: number[] = [];
    let finish: () => void = () => {};
    const onTick = (dt?: number) => {
      dts.push(dt ?? -1);
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    };
    mounted = mount(<Loop frame running onTick={onTick} />);
    wall += 16;
    frame(16);
    wall += 16;
    frame(16);
    expect(dts).toHaveLength(1);
    // The tick takes 400 ms to answer, and no frame is drawn meanwhile: the page's thread was busy with it.
    wall += 400;
    await act(async () => {
      finish();
    });
    wall += 4;
    frame(404);
    expect(dts).toHaveLength(2);
    // The step is the time that passed, as far as a step may go.
    expect(dts[1]).toBe(0.2);
  });

  // Every frame of a screen that draws three a second comes after a wait
  // long enough to be a screen that stopped. Taken for one each time, the
  // clock was set at every frame and the game was never ticked at all.
  it('ticks on a screen slower than four frames a second, each frame with the longest step', async () => {
    let wall = 5000;
    vi.spyOn(performance, 'now').mockImplementation(() => wall);
    const dts: number[] = [];
    mounted = mount(<Loop frame running onTick={(dt) => void dts.push(dt ?? -1)} />);
    for (let i = 0; i < 20; i++) {
      wall += 300;
      frame(300);
      await flush();
    }
    // The first frame sets the clock, as the first frame always does.
    expect(dts).toHaveLength(19);
    expect(dts.every((dt) => dt === 0.2)).toBe(true);
  });

  // A page that takes 300 ms to draw again after each tick draws its next
  // frame that long after the last: a long wait, a frame, a long wait. Each
  // was taken for a screen that stopped, and the game got one 16 ms step
  // for every redraw.
  it('ticks a page that is slow to draw again after each tick once for each redraw, with the longest step', async () => {
    let wall = 5000;
    vi.spyOn(performance, 'now').mockImplementation(() => wall);
    const dts: number[] = [];
    mounted = mount(<Loop frame running onTick={(dt) => void dts.push(dt ?? -1)} />);
    const draw = async (ms: number) => {
      wall += ms;
      frame(ms);
      await flush();
    };
    await draw(16);
    await draw(16);
    await draw(16);
    expect(dts).toHaveLength(2);
    // The first long wait after ordinary frames could be a screen that
    // stopped, and is taken for one: nothing moves.
    await draw(300);
    expect(dts).toHaveLength(2);
    // No tick, so nothing to draw again: the next frame comes at once.
    await draw(16);
    expect(dts).toHaveLength(3);
    // From the second long wait on it is the page that is slow.
    for (let i = 0; i < 5; i++) await draw(300);
    expect(dts).toHaveLength(8);
    expect(dts.slice(3)).toEqual([0.2, 0.2, 0.2, 0.2, 0.2]);

    // Quick again for a while, and then a long wait: a screen that stopped, as before.
    await draw(16);
    await draw(16);
    await draw(16);
    expect(dts).toHaveLength(11);
    await draw(3000);
    expect(dts).toHaveLength(11);
    await draw(16);
    expect(Math.round(dts[11] * 1000)).toBe(16);
  });

  // "Never two at once" is right for a step that is merely slow. A step
  // that waits on a request stopped the game for as long as the request
  // took, and one that never answered stopped it for good, without a word.
  it('goes on without a tick that has not finished after two seconds, says so once, and does not hear the late one', async () => {
    let wall = 5000;
    vi.spyOn(performance, 'now').mockImplementation(() => wall);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dts: number[] = [];
    const finish: Array<() => void> = [];
    const onTick = (dt?: number) => {
      dts.push(dt ?? -1);
      // A step that waits on something that has not answered.
      return new Promise<void>((resolve) => {
        finish.push(resolve);
      });
    };
    mounted = mount(<Loop frame running onTick={onTick} />);
    const draw = (ms: number) => {
      wall += ms;
      frame(ms);
    };
    draw(16);
    draw(16);
    expect(dts).toHaveLength(1);
    // Two seconds of frames, and the loop waits: the step may only be slow.
    for (let i = 0; i < 20; i++) draw(100);
    expect(dts).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    // Past two seconds it goes on, with the longest step.
    draw(100);
    expect(dts).toHaveLength(2);
    expect(dts[1]).toBe(0.2);
    expect(warn).toHaveBeenCalledTimes(1);
    const said = String(warn.mock.calls[0][0]);
    expect(said).toContain('<Loop frame>');
    expect(said).toContain('2 seconds');
    expect(said).toContain('read its result on a later tick');

    // The second does not answer either: left behind too, and nothing more is said.
    for (let i = 0; i < 21; i++) draw(100);
    expect(dts).toHaveLength(3);
    expect(warn).toHaveBeenCalledTimes(1);

    // The first answers at last. The loop is waiting for the third, not for it.
    await act(async () => {
      finish[0]();
    });
    draw(16);
    expect(dts).toHaveLength(3);
    // The third answers: the loop ticks on the next frame, as it does after any tick.
    await act(async () => {
      finish[2]();
    });
    draw(16);
    expect(dts).toHaveLength(4);

    // Stopped and started again, the same <Loop> has said it already.
    const stopped = <Loop frame running={false} onTick={onTick} />;
    mounted.rerender(stopped);
    mounted.rerender(<Loop frame running onTick={onTick} />);
    draw(16);
    draw(16);
    expect(dts).toHaveLength(5);
    for (let i = 0; i < 21; i++) draw(100);
    expect(dts).toHaveLength(6);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('says it for each <Loop> that goes on without a tick', () => {
    let wall = 5000;
    vi.spyOn(performance, 'now').mockImplementation(() => wall);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const never = () => new Promise<void>(() => {});
    mounted = mount(
      <>
        <Loop frame running onTick={never} />
        <Loop frame running onTick={never} />
      </>
    );
    const draw = (ms: number) => {
      wall += ms;
      frame(ms);
    };
    draw(16);
    draw(16);
    for (let i = 0; i < 21; i++) draw(100);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('with maxFps, ticks at that rate on a faster screen', async () => {
    const dts: number[] = [];
    mounted = mount(<Loop frame maxFps={30} running onTick={(dt) => void dts.push(dt ?? -1)} />);
    // A 60 Hz screen: every other frame is a tick, each a thirtieth of a second.
    for (let i = 0; i < 13; i++) {
      frame(1000 / 60);
      await flush();
    }
    expect(dts).toHaveLength(6);
    for (const dt of dts) expect(dt).toBeCloseTo(1 / 30, 3);
  });

  it('with maxFps above the screen’s rate, ticks on every frame', async () => {
    const onTick = vi.fn();
    mounted = mount(<Loop frame maxFps={240} running onTick={onTick} />);
    for (let i = 0; i < 6; i++) {
      frame(1000 / 60);
      await flush();
    }
    expect(onTick).toHaveBeenCalledTimes(5);
  });

  it('does not tick while the host is showing another app, and comes back with one frame’s step', async () => {
    const dts: number[] = [];
    const loop = <Loop frame running onTick={(dt) => void dts.push(dt ?? -1)} />;
    mounted = mount(inApp(true, loop));
    frame(16);
    frame(16);
    await flush();
    expect(dts).toHaveLength(1);

    // Another app is chosen: this one is still mounted, and asks for no frames.
    mounted.rerender(inApp(false, loop));
    expect(pending.size).toBe(0);
    frame(16);
    frame(60_000);
    expect(dts).toHaveLength(1);

    // Chosen again a minute later: the first frame sets the clock, and the
    // step after it is the frame's, not the minute's.
    mounted.rerender(inApp(true, loop));
    frame(16);
    expect(dts).toHaveLength(1);
    frame(17);
    await flush();
    expect(dts).toHaveLength(2);
    expect(Math.round(dts[1] * 1000)).toBe(17);
  });

  it('does not tick while the browser’s tab is hidden, and comes back with one frame’s step', async () => {
    const dts: number[] = [];
    mounted = mount(<Loop frame running onTick={(dt) => void dts.push(dt ?? -1)} />);
    frame(16);
    frame(16);
    await flush();
    expect(dts).toHaveLength(1);

    showDocument(false);
    expect(pending.size).toBe(0);
    frame(120_000);
    expect(dts).toHaveLength(1);

    showDocument(true);
    expect(pending.size).toBe(1);
    frame(16);
    expect(dts).toHaveLength(1);
    frame(16);
    await flush();
    expect(dts).toHaveLength(2);
    expect(Math.round(dts[1] * 1000)).toBe(16);
  });

  it('started while the tab is hidden, waits for it to be shown', async () => {
    const onTick = vi.fn();
    showDocument(false);
    mounted = mount(<Loop frame running onTick={onTick} />);
    expect(pending.size).toBe(0);
    showDocument(true);
    frame();
    frame();
    await flush();
    expect(onTick).toHaveBeenCalledTimes(1);
  });
});

describe('<Loop> on a timer', () => {
  const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  it('ticks every interval with the seconds since the last, as it always has', async () => {
    const dts: number[] = [];
    mounted = mount(<Loop interval={20} running onTick={(dt) => void dts.push(dt ?? -1)} />);
    await wait(130);
    expect(dts.length).toBeGreaterThanOrEqual(3);
    expect(dts.length).toBeLessThanOrEqual(7);
    for (const dt of dts) {
      expect(dt).toBeGreaterThanOrEqual(0.001);
      expect(dt).toBeLessThanOrEqual(0.2);
    }
    // It asks the screen for nothing.
    expect(pending.size).toBe(0);
  });

  it('goes on in the background unless it is asked to stop there: an app with a timer is as it was', async () => {
    const onTick = vi.fn();
    mounted = mount(inApp(false, <Loop interval={10} running onTick={onTick} />));
    showDocument(false);
    await wait(80);
    expect(onTick.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('with pauseHidden, stops while the app is in the background and starts again when it is shown', async () => {
    const onTick = vi.fn();
    const loop = <Loop interval={10} pauseHidden running onTick={onTick} />;
    mounted = mount(inApp(false, loop));
    await wait(60);
    expect(onTick).not.toHaveBeenCalled();
    mounted.rerender(inApp(true, loop));
    await wait(60);
    expect(onTick.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('with pauseHidden, stops while the tab is hidden, and the first tick back is one interval long', async () => {
    const dts: number[] = [];
    mounted = mount(<Loop interval={10} pauseHidden running onTick={(dt) => void dts.push(dt ?? -1)} />);
    await wait(40);
    showDocument(false);
    await wait(20);
    const before = dts.length;
    expect(before).toBeGreaterThanOrEqual(1);
    await wait(150);
    expect(dts.length).toBe(before);
    showDocument(true);
    await wait(50);
    expect(dts.length).toBeGreaterThan(before);
    // Not the 150 ms it was away.
    expect(dts[before]).toBeLessThan(0.1);
  });

  it('with frame and no screen to follow, keeps the rate on a timer', async () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    const onTick = vi.fn();
    mounted = mount(<Loop frame maxFps={50} running onTick={onTick} />);
    await wait(120);
    expect(onTick.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
