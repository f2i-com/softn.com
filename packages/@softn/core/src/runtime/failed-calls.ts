/**
 * Whether a call of a logic function failed, for whoever is waiting on it.
 *
 * A function the page calls answers a promise that never rejects: when the
 * function throws, the runtime says so on the console, naming it, and the
 * app goes on (handler-errors.test.tsx). That is right for a caller that does
 * not wait, and it leaves one that does with nothing to go by: a failed call
 * and a function that returns nothing both resolve to nothing.
 *
 * A handler waits. In `@click={save(currentDraft())}` it has to know that
 * `currentDraft` threw, so that `save` is not called with nothing in the
 * draft's place. So each runtime keeps, beside the promise it hands out, how
 * the call went, and the handler's evaluator asks (renderer/evaluate.ts).
 * Nothing about the promise changes: it resolves as it always has.
 */

/** How one call went. The runtime that made the call sets `failed`. */
export interface CallOutcome {
  failed: boolean;
}

const outcomes = new WeakMap<object, CallOutcome>();

/** Keep `outcome` beside the promise of the call it is about, and hand the promise back. */
export function withOutcome<T extends object>(call: T, outcome: CallOutcome): T {
  outcomes.set(call, outcome);
  return call;
}

/** True when `call` is the promise of a logic call that failed, which the runtime has said. */
export function callFailed(call: unknown): boolean {
  return call !== null && typeof call === 'object' && outcomes.get(call)?.failed === true;
}
