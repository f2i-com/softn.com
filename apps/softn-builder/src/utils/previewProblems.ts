/**
 * What the app's logic said went wrong while it ran in Preview.
 *
 * A handler that throws, a call that never ends, a value too large to hand
 * back: the runtime survives each of them (a call is given a budget of
 * steps, and a loop with no end is stopped when it is spent, so the editor's
 * tab is not held), and says so in the browser's console and nowhere else.
 * In Preview that was a button that did nothing. Worse, a call that spends
 * its budget takes the engine with it: every later press was ignored while
 * the header went on saying "Running", and nothing on the screen said the
 * app had stopped or how to start it again.
 *
 * The runtime has no other way to be heard on the thread Preview runs it
 * on, so its sentences are read where it writes them: every line it sends
 * to `console.error` is marked `[SoftN]` (or `[zipp bridge]`), and while
 * Preview is open those lines are kept and shown above the app. Studio's
 * check of an app reads the same lines the same way (appCheck.ts).
 */

export interface PreviewProblem {
  /** What went wrong, in one sentence. */
  text: string;
  /** Whether the engine itself has stopped: nothing in the app answers until it is started again. */
  stopped: boolean;
}

/** The runtime's own marks on a line it writes. */
const MARK = /^\[(?:SoftN|zipp bridge)\]\s*/;

/**
 * Lines that are not a problem of their own: the stack React prints beside
 * an error, and the two failures the renderer already shows in place of the
 * app (a script that would not load, a page that could not be drawn).
 */
const NOT_SHOWN = /^(?:Component stack:|Error loading script:|Runtime error:)/;

/** What the engine says of a call that spent its budget, and of every call after it. */
const STOPPED = /exceeded its (?:instruction|execution) budget|engine is disposed|script engine has stopped/i;

function worded(value: unknown): string {
  if (value instanceof Error) return value.name && value.name !== 'Error' ? `${value.name}: ${value.message}` : value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * The problem one `console.error` call reports, or null when the call is
 * not the runtime's or is nothing a person can act on.
 */
export function readRuntimeProblem(args: readonly unknown[]): PreviewProblem | null {
  const [first, ...rest] = args;
  if (typeof first !== 'string' || !MARK.test(first)) return null;
  const head = first.replace(MARK, '').trim();
  if (head === '' || NOT_SHOWN.test(head)) return null;
  const detail = rest.map(worded).join(' ').trim();
  const stopped = STOPPED.test(`${head} ${detail}`);

  // The lines a person meets most, said about their function and not the runtime's.
  const called = /^Error executing (?:sync )?function (\w+):$/.exec(head);
  if (called) return { text: `${called[1]}() failed: ${detail}`, stopped };
  const synced = /^Error syncing state after (\w+):$/.exec(head);
  if (synced) return { text: `What ${synced[1]}() changed could not be read back: ${detail}`, stopped };
  return { text: detail === '' ? head : `${head} ${detail}`, stopped };
}

/** How many different sentences are kept: the first ones said are the cause, and a page can say a new one at every drawing. */
const KEPT = 20;

/**
 * `problems` with one more said. The same list is handed back, and not a
 * copy of it, where the sentence is kept already or the list is full: what
 * shows them redraws only for something new.
 */
export function withProblem(problems: readonly PreviewProblem[], said: PreviewProblem): readonly PreviewProblem[] {
  if (problems.length >= KEPT || problems.some((problem) => problem.text === said.text)) return problems;
  return [...problems, said];
}

/**
 * Hear what the runtime writes to `target.error` until the function handed
 * back is called. Every line still reaches the console as it did.
 */
export function watchRuntimeProblems(
  target: Pick<Console, 'error'>,
  report: (problem: PreviewProblem) => void
): () => void {
  const original = target.error;
  const heard = (...args: unknown[]): void => {
    original.apply(target, args);
    try {
      const problem = readRuntimeProblem(args);
      if (problem) report(problem);
    } catch {
      // A line that cannot be read is in the console all the same.
    }
  };
  target.error = heard;
  return () => {
    // Only where nothing has been put over it since: that one is not ours to take away.
    if (target.error === heard) target.error = original;
  };
}

/**
 * The sentence above the app for a logic that has stopped. A call that ran
 * out of steps is the usual cause, and the function is named where the
 * runtime named it.
 */
export function stoppedSentence(problems: readonly PreviewProblem[]): string {
  const first = problems.find((problem) => problem.stopped);
  const named = first ? /^(\w+)\(\) failed: .*budget/.exec(first.text)?.[1] : undefined;
  const rest = 'Nothing in the app answers until the preview is restarted.';
  return named ? `${named}() ran past the number of steps one call is given, which is what a loop that never ends does. ${rest}` : rest;
}
