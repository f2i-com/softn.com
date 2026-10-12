/**
 * `setTimeout`, `setInterval`, `clearTimeout` and `clearInterval` for `.logic`,
 * kept on the host's clock.
 *
 * ZIPP declares a `setTimeout` of its own, for its command line, and in a page
 * it is worse than none. Inside a function its callback is queued on an event
 * loop nothing in a page runs, so it never fires and nothing says so. At the
 * top level of a script the engine waits for it by sleeping, which
 * WebAssembly in a page cannot do, and the script fails to load with
 * "unreachable". The other three do not exist. Authors write all four, and so
 * does Studio's AI.
 *
 * So the runtimes put {@link timerPreamble} in front of every JavaScript
 * script. Each wait is a `host.call` the host answers when it is due, through
 * {@link LogicTimers}, and the callback then runs the way a handler does: its
 * writes reach the page and the page is drawn again. An interval asks for its
 * next wait before its callback runs, so a callback that throws or clears its
 * own interval behaves as it would in a browser.
 *
 * One thing ZIPP's own did is kept: a timeout set at the top level that is
 * already due when the top level ends (a delay of 0, most often) ran before
 * the script finished loading, so what it wrote was in the state the page
 * started with and an `_init` saw it. {@link TIMER_TRAILER}, put after the
 * script, runs those then, in the order they came due. One difference: ZIPP
 * ran the microtasks a callback queued before the next callback, and here
 * they run after the last, still before the load returns. Waiting for them
 * in between would leave the rest to run after the load on the
 * host-JavaScript engine, where the host would not see what they wrote.
 *
 * This module imports nothing at run time: the worker's script uses the
 * preamble, and both runtimes on the page use the clock.
 */

import type { PendingHostCall } from './script-runtime';

/** The `host.call` kind of one wait; its arguments are the timer's id and its delay. */
export const TIMER_WAIT = 'timer.wait';
/** The `host.call` kind that stops a timer early; its argument is the timer's id. */
export const TIMER_CLEAR = 'timer.clear';

/**
 * The shortest wait. A zero-delay interval would otherwise enter the engine as
 * fast as the host can turn round; browsers clamp a nested timer to the same.
 */
const MIN_DELAY_MS = 4;
/** The longest wait a browser timer holds; a longer one fires at once. */
const MAX_DELAY_MS = 2_147_483_647;

/** Timers a script may have waiting at once. */
const MAX_LIVE_TIMERS = 10_000;

/**
 * Timeouts run as the script loads, at most. One that sets another with no
 * delay, forever, would otherwise never let the load end; past this many the
 * rest wait on the host's clock like any other.
 */
const MAX_SETTLED_AT_LOAD = 1_000;

/** The four functions the preamble declares. */
const TIMER_FUNCTIONS = ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] as const;

/** The preamble's own binding, which holds the timers between calls. */
const TIMER_STATE = '__softnTimers';

/**
 * Every top-level name the preamble may declare. The runtimes leave these out
 * of the script's state and functions, as they leave out `window` and `host`.
 */
export const TIMER_PREAMBLE_NAMES: readonly string[] = [TIMER_STATE, ...TIMER_FUNCTIONS];

const TIMER_STATE_SOURCE = `let ${TIMER_STATE} = (function () {
  var live = Object.create(null);
  var count = 0;
  var last = 0;
  function wait(id, timer) {
    host.call("${TIMER_WAIT}", [id, timer.ms], function () {
      if (live[id] !== timer) return;
      if (timer.repeat) {
        try { wait(id, timer); } catch (e) { delete live[id]; count--; throw e; }
      } else {
        delete live[id];
        count--;
      }
      // Called, not applied: on ZIPP a promise's resolve function has no
      // apply or call, and resolve is what an awaited sleep hands in.
      timer.fn(...timer.args);
    });
  }
  function due() {
    var now = Date.now();
    var first = 0;
    for (var key in live) {
      var timer = live[key];
      if (timer.repeat || timer.due > now) continue;
      if (first === 0 || timer.due < live[first].due) first = Number(key);
    }
    return first;
  }
  return {
    start: function (name, fn, ms, args, repeat) {
      if (typeof fn !== "function") {
        throw new TypeError(name + " needs a function to call: logic cannot run code given as text");
      }
      if (count >= ${MAX_LIVE_TIMERS}) throw new RangeError(name + ": ${MAX_LIVE_TIMERS} timers are already waiting");
      var delay = Number(ms);
      if (!(delay > 0)) delay = 0;
      var timer = { fn: fn, ms: delay, due: Date.now() + delay, args: args, repeat: repeat };
      var id = ++last;
      wait(id, timer);
      live[id] = timer;
      count++;
      return id;
    },
    stop: function (id) {
      if (typeof id !== "number" || !live[id]) return;
      delete live[id];
      count--;
      host.call("${TIMER_CLEAR}", [id]);
    },
    settle: function () {
      for (var run = 0; run < ${MAX_SETTLED_AT_LOAD}; run++) {
        var id = due();
        if (id === 0) return;
        var timer = live[id];
        delete live[id];
        count--;
        try {
          timer.fn(...timer.args);
        } catch (e) {
          console.error("[SoftN] A timer callback in the logic failed:", e);
        }
      }
    }
  };
})();
`;

/**
 * Put after a script, it runs the top-level timeouts already due when the
 * top level ends, before the load returns. See the head of this file.
 */
export const TIMER_TRAILER = `\n;${TIMER_STATE}.settle();\n`;

const TIMER_FUNCTION_SOURCE: Record<(typeof TIMER_FUNCTIONS)[number], string> = {
  setTimeout: `function setTimeout(fn, ms, ...args) { return ${TIMER_STATE}.start("setTimeout", fn, ms, args, false); }\n`,
  setInterval: `function setInterval(fn, ms, ...args) { return ${TIMER_STATE}.start("setInterval", fn, ms, args, true); }\n`,
  clearTimeout: `function clearTimeout(id) { ${TIMER_STATE}.stop(id); }\n`,
  clearInterval: `function clearInterval(id) { ${TIMER_STATE}.stop(id); }\n`,
};

/**
 * The timer preamble for `code`.
 *
 * A function the script declares itself with `function` or `var` simply
 * replaces the preamble's, as a later declaration does. One it declares with
 * `let`, `const` or `class` would collide with it and fail the compile, so
 * that one is left out and the script keeps its own. The test is on the text,
 * so a name in a string or a nested scope leaves one out too; the cost is only
 * that the name means what it meant before this preamble existed.
 */
export function timerPreamble(code: string): string {
  let source = TIMER_STATE_SOURCE;
  for (const name of TIMER_FUNCTIONS) {
    if (new RegExp(`\\b(?:let|const|class)\\s+${name}\\b`).test(code)) continue;
    source += TIMER_FUNCTION_SOURCE[name];
  }
  return source;
}

/** The delay a wait asks for, as a browser timer can hold it. */
function delayOf(raw: string | undefined): number {
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < MIN_DELAY_MS) return MIN_DELAY_MS;
  return Math.min(ms, MAX_DELAY_MS);
}

/**
 * The host's side of the script's timers: a browser timer for each wait.
 *
 * `answer` is called with the `host.call` id of a wait that is due, or of one
 * that was stopped early; it is the runtime's to enter the engine and resolve
 * it. A stopped wait is answered too, so the script lets go of its callback:
 * the callback sees its timer is no longer live and does nothing.
 *
 * The waits are taken out of the host calls before the rest are run, at every
 * place the runtimes drain them. Run with the rest, one at a time and awaited,
 * a wait would hold up every call queued after it, and each fire would count
 * toward the limit on a chain of callbacks, which ends an interval after a few
 * hundred ticks.
 */
export class LogicTimers {
  private readonly waiting = new Map<string, { handle: ReturnType<typeof setTimeout>; callId: number }>();
  private stopped = false;

  constructor(private readonly answer: (callId: number) => void) {}

  /** How many waits the host is holding. */
  get size(): number {
    return this.waiting.size;
  }

  /** Start or stop the timer calls among `calls`, and return the others in order. */
  take(calls: readonly PendingHostCall[]): PendingHostCall[] {
    const rest: PendingHostCall[] = [];
    for (const call of calls) {
      if (call.kind === TIMER_WAIT) this.wait(call);
      else if (call.kind === TIMER_CLEAR) this.stop(String(call.args[0]));
      else rest.push(call);
    }
    return rest;
  }

  /**
   * Stop every wait without answering it: the engine that asked is being
   * replaced. Its call ids mean nothing to the next one, which numbers its
   * own from the start.
   */
  clear(): void {
    for (const { handle } of this.waiting.values()) clearTimeout(handle);
    this.waiting.clear();
  }

  /** Stop every wait and take no more: the runtime is going. */
  dispose(): void {
    this.stopped = true;
    this.clear();
  }

  private wait(call: PendingHostCall): void {
    if (this.stopped) return;
    const id = String(call.args[0]);
    // A script asks again for a timer only once the last wait was answered;
    // the guest's own bookkeeping guarantees it, and this keeps one per id.
    this.stop(id);
    const handle = setTimeout(() => {
      if (this.waiting.get(id)?.handle !== handle) return;
      this.waiting.delete(id);
      this.answer(call.id);
    }, delayOf(call.args[1]));
    this.waiting.set(id, { handle, callId: call.id });
  }

  private stop(id: string): void {
    const entry = this.waiting.get(id);
    if (!entry) return;
    clearTimeout(entry.handle);
    this.waiting.delete(id);
    this.answer(entry.callId);
  }
}
