/**
 * Loop Component
 *
 * A clock for a game or an animation: it calls `@tick` again and again while
 * `running`, handing it the time since the last call in seconds. Renders
 * nothing visible — returns null.
 *
 * Two forms. The timer form calls every `interval` milliseconds, whatever the
 * screen is doing. The frame form (`frame`) calls once for each frame the
 * screen draws, so what the tick moved is on the very next frame, and it
 * stops while nobody can see the app: another app chosen in the host, or the
 * browser's tab in the background. A game left running there is a game lost
 * unseen.
 *
 * Either way a tick is never started while the last one is still running,
 * and the step handed over is never longer than a fifth of a second: a game
 * multiplies its speeds by it, and a long step is a wall walked through.
 *
 * The frame form does not wait for ever. A tick that has not finished after
 * two seconds is left behind: the loop ticks again, says so once in the
 * console, and takes no notice of the late one when it does finish. A step
 * that waits on a network request would otherwise stop the game for as long
 * as the request takes, and one that never answers would stop it for good.
 */

import { useEffect, useRef } from 'react';
import { useAppActive } from '@softn/core';

export interface LoopProps {
  /**
   * Milliseconds between ticks of the timer form (default 1000). Not read
   * with `frame`, which follows the screen.
   */
  interval?: number;
  /** Whether the loop is running (default false) */
  running?: boolean;
  /**
   * Tick once for each frame the screen draws (usually 60 a second, more on
   * a fast display) instead of on a timer, and not at all while the app or
   * the browser's tab is hidden. The first tick after it is shown again
   * carries one frame's time, not the time it was away. Write movement as
   * speed times `dt`, since the rate is the screen's: `x += 220 * dt`. On a
   * screen or a page too slow to draw four frames a second, each frame still
   * ticks, with the longest step (`dt` 0.2).
   */
  frame?: boolean;
  /**
   * With `frame`, the most ticks in a second: `maxFps={30}` for logic that
   * is too heavy to run on every frame. Left out, every frame ticks.
   */
  maxFps?: number;
  /**
   * For the timer form: stop ticking while the app or the browser's tab is
   * hidden, and start again when it is shown (default false, so a timer that
   * keeps time in the background still does). `frame` always stops there.
   */
  pauseHidden?: boolean;
  /**
   * Called on each tick with `dt`, the seconds since the last one (between
   * 0.001 and 0.2). The next tick waits for this one to finish; with `frame`
   * it waits two seconds at most, then goes on without it and says so once
   * in the console. Do not wait on a request inside the step: start it, and
   * read its result on a later tick.
   */
  onTick?: (dt?: number) => void | Promise<void>;
}

/** The shortest and the longest step a tick is handed, in seconds. */
const MIN_DT = 0.001;
const MAX_DT = 0.2;

/**
 * How early a frame may be, in milliseconds, and still be the one `maxFps`
 * was waiting for: frames arrive a fraction of a millisecond either side of
 * when they are due, and a late one must not cost a whole frame more.
 */
const FRAME_SLACK_MS = 1;

/**
 * How long the screen may go without drawing a frame, while no tick is
 * running, before the frame loop takes it that nobody was being shown the
 * game: longer than the longest step, so a slow frame is still a step.
 * Once is a pause. Again, with no more than one tick in between, is a
 * screen or a page that is that slow all the time (see `onFrame`).
 */
const STALL_MS = 250;

/**
 * How long the frame loop waits for a tick that has not finished before it
 * goes on without it, in milliseconds. Long enough that a step which is
 * merely slow is never run twice at once; short enough that one which waits
 * on a request, or never answers, does not leave the game stopped.
 */
const TICK_WAIT_MS = 2000;

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const stepBetween = (from: number, to: number): number => Math.min(MAX_DT, Math.max(MIN_DT, (to - from) / 1000));

function documentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** What a running loop can be told: stop while hidden, go on when shown, stop for good. */
interface Ticker {
  pause(): void;
  resume(): void;
  stop(): void;
}

/** The timer form: a tick every `interval` milliseconds, each after the last has finished. */
function timerTicker(interval: number, tick: (dt: number) => void | Promise<void>): Ticker {
  let stopped = false;
  let paused = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let lastTickTime = clock();

  const scheduleNext = (delayMs: number) => {
    if (stopped || paused) return;
    timeoutId = setTimeout(fire, Math.max(0, delayMs));
  };

  const fire = () => {
    timeoutId = null;
    if (stopped || paused) return;
    if (inFlight) {
      // Guard against overlap under heavy load: never queue multiple concurrent ticks.
      scheduleNext(interval);
      return;
    }
    inFlight = true;
    const startedAt = clock();
    const dt = stepBetween(lastTickTime, startedAt);
    lastTickTime = startedAt;
    Promise.resolve()
      .then(() => tick(dt))
      .catch(() => {
        // Swallow tick errors so one failure does not permanently stop the loop.
      })
      .finally(() => {
        inFlight = false;
        if (stopped) return;
        scheduleNext(interval - (clock() - startedAt));
      });
  };

  const clear = () => {
    if (timeoutId !== null) clearTimeout(timeoutId);
    timeoutId = null;
  };

  scheduleNext(interval);

  return {
    pause() {
      paused = true;
      clear();
    },
    resume() {
      if (!paused || stopped) return;
      paused = false;
      // The time away is not a step: the next tick is one interval long.
      lastTickTime = clock();
      // A tick still running schedules the next one itself when it ends.
      if (!inFlight) scheduleNext(interval);
    },
    stop() {
      stopped = true;
      clear();
    },
  };
}

/**
 * The frame form: a tick for each frame the screen draws, `maxFps` a second
 * at most. `leftBehind` is called each time a tick is given up on.
 */
function frameTicker(maxFps: number | undefined, tick: (dt: number) => void | Promise<void>, leftBehind: () => void): Ticker {
  const gap = typeof maxFps === 'number' && Number.isFinite(maxFps) && maxFps > 0 ? 1000 / maxFps : 0;
  let stopped = false;
  let paused = false;
  let handle = 0;
  /** The tick being waited for, with when it was started by the page's own clock; null when none is. */
  let waiting: { since: number } | null = null;
  /** When the last tick was handed over; null until a frame has set the clock. */
  let last: number | null = null;
  /** With `maxFps`, when the next tick is due. */
  let due = 0;
  /** When a frame last came or a tick last ended, by the page's own clock. */
  let busyAt = clock();
  /** The ticks handed over since the screen last went without a frame for longer than STALL_MS. */
  let ticksSinceStall = Infinity;

  const request = () => {
    if (stopped || paused || handle !== 0) return;
    handle = requestAnimationFrame(onFrame);
  };

  const onFrame = (stamp: number) => {
    handle = 0;
    if (stopped || paused) return;
    request();
    const now = typeof stamp === 'number' && Number.isFinite(stamp) ? stamp : clock();
    const wall = clock();
    if (wall - busyAt > STALL_MS) {
      // The screen stopped drawing for a while with no tick running, and
      // nobody said the page was hidden: a tab behind another in some hosts,
      // a frame scrolled out of sight, a computer that slept. That time is
      // not a step of the game either, so the clock is set again as below.
      //
      // That is what one long wait after the loop has been ticking means. A
      // second, with no more than one tick since the first, is something
      // else: a screen that draws fewer than four frames a second, or a
      // page that takes that long to draw again after each tick. Every
      // frame of those comes after a long wait, and setting the clock at
      // each would leave the game with no ticks at all, or with one short
      // step for each slow redraw. Those tick, with the longest step.
      if (ticksSinceStall > 1) last = null;
      ticksSinceStall = 0;
    }
    busyAt = wall;
    // The first frame since the loop started, or since it was shown again,
    // only sets the clock: the time before it is not a step of the game.
    if (last === null) {
      last = now;
      due = now + gap;
      return;
    }
    if (waiting !== null) {
      // Never two at once. The frame is passed over, and the tick that comes
      // after this one ends is handed the longer step.
      if (wall - waiting.since <= TICK_WAIT_MS) return;
      // But not for ever: a tick still running after this long is waiting on
      // something, or will never answer. The loop goes on without it.
      waiting = null;
      leftBehind();
    }
    if (gap > 0) {
      if (now < due - FRAME_SLACK_MS) return;
      // Kept in step with the rate asked for; a loop that has fallen behind
      // starts again from now rather than ticking in a burst to catch up.
      due = due + gap > now ? due + gap : now + gap;
    }
    const dt = stepBetween(last, now);
    last = now;
    ticksSinceStall++;
    const mine = { since: wall };
    waiting = mine;
    let result: void | Promise<void>;
    try {
      result = tick(dt);
    } catch {
      // One tick failing does not stop the loop; the runtime has said so.
      result = undefined;
    }
    Promise.resolve(result)
      .catch(() => {
        // As above.
      })
      .finally(() => {
        // A tick the loop went on without ends unheard: another may be
        // running by now, and it is that one the loop is waiting for.
        if (waiting !== mine) return;
        waiting = null;
        // A tick that took long is logic that is behind, not a screen that stopped.
        busyAt = clock();
      });
  };

  const cancel = () => {
    if (handle !== 0) cancelAnimationFrame(handle);
    handle = 0;
  };

  request();

  return {
    pause() {
      paused = true;
      cancel();
    },
    resume() {
      if (!paused || stopped) return;
      paused = false;
      last = null;
      // The time it was hidden was said to be that: it is not the screen
      // going without a frame, which is counted from here.
      busyAt = clock();
      request();
    },
    stop() {
      stopped = true;
      cancel();
    },
  };
}

export function Loop({ interval = 1000, running = false, frame = false, maxFps, pauseHidden = false, onTick }: LoopProps) {
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;
  /** Whether this loop has said that it went on without a tick: once is enough to be read. */
  const saidLeftBehind = useRef(false);

  // Whether the host is showing this app: SoftN Web keeps every open app
  // mounted and shows one. The browser's own tab is asked about below.
  const appShown = useAppActive();
  const stopsHidden = frame || pauseHidden;
  const on = running && (appShown || !stopsHidden);

  useEffect(() => {
    if (!on) return;

    const tick = (dt: number) => onTickRef.current?.(dt);
    const leftBehind = () => {
      if (saidLeftBehind.current) return;
      saidLeftBehind.current = true;
      console.warn(
        `[SoftN] A tick of <Loop frame> had not finished after ${TICK_WAIT_MS / 1000} seconds, so the loop went on without it. ` +
          'A step that waits on something slow (a network request, a file, an answer from the person) stops the game for as long as that takes. ' +
          'Do not wait on a request inside the step: start it, and read its result on a later tick. ' +
          'This is said once for each <Loop>.'
      );
    };
    const onFrames = frame && typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function';
    // Where there are no frames to follow (no window), the frame form keeps
    // the rate it was asked for, or sixty a second, on a timer.
    const ticker = onFrames
      ? frameTicker(maxFps, tick, leftBehind)
      : timerTicker(frame ? 1000 / (typeof maxFps === 'number' && maxFps > 0 ? maxFps : 60) : interval, tick);

    if (!stopsHidden || typeof document === 'undefined') return () => ticker.stop();

    // The browser's tab going to the background and coming back. Heard here
    // and not through React, so the clock is set again before the first
    // frame of the return can be handed the whole absence.
    const follow = () => {
      if (documentHidden()) ticker.pause();
      else ticker.resume();
    };
    if (documentHidden()) ticker.pause();
    document.addEventListener('visibilitychange', follow);
    return () => {
      document.removeEventListener('visibilitychange', follow);
      ticker.stop();
    };
  }, [on, frame, interval, maxFps, stopsHidden]);

  return null;
}
