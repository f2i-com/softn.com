/**
 * What an app's logic said went wrong while it ran, read for the person and
 * for the agent.
 *
 * The runtime has one way of saying that a script failed: a line on the
 * browser's console that begins "[SoftN]". Studio does not show that
 * console, so none of it reached the person: a handler that threw did
 * nothing, in silence. The worst of them is the stop. A call that never
 * returns (`while (true) {}`, a function that calls itself without end, a
 * pattern that backtracks for ever) does not freeze the page, because the
 * engine counts its steps and cuts the call off; but the engine is finished
 * after that, and every later call is ignored. The preview went on saying
 * "Running" over an app in which no button did anything.
 *
 * So the runtime's lines are read here: which of them mean the engine has
 * stopped, and what to say of each in words that name the cause. The canvas
 * listens while an app is running in it (components/canvas/VisualCanvas.tsx),
 * shows the stop and offers a restart; the check and run_app_function pass
 * the engine's lines through {@link explainEngineStops}; and what the
 * person's preview reported is kept until the agent's next run is told it.
 */

export interface AppFault {
  /** The line for Studio's log and the agent; empty for a line that only repeats the one before it. */
  text: string;
  /** The app's engine has stopped: nothing in it runs again until it is restarted. */
  stopped: boolean;
}

const MARK = '[SoftN]';
/** The engine's two fuses: steps of script, and steps of one regular expression. */
const SCRIPT_BUDGET = /script exceeded its instruction budget/i;
const REGEX_BUDGET = /regular expression exceeded its execution budget/i;
/** What every call answers once a fuse has blown, and the runtime's own word for it. */
const ENGINE_GONE = /engine is disposed|script engine has stopped/i;
const IN_FUNCTION = /Error executing (?:sync )?function ([\w$]+):/;

const STOPPED_THERE = 'The app’s logic stopped there: nothing in it runs again until it is restarted.';

/** One argument of a console line as text: an error is its message. */
function show(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** A line of the runtime's read in full: the fault, and whose function it was about. */
interface FaultDetail {
  fault: AppFault;
  /** The function the line is about, when it is about one. */
  fn?: string;
  /** A function called from the markup while it is drawn, which every drawing of the page runs. */
  sync: boolean;
  /** A fuse blew (`budget`), a line that follows one (`gone`), a call that threw (`failed`), or anything else. */
  kind: 'budget' | 'gone' | 'failed' | 'other';
}

/** A line of the runtime's, whole, as one fault; null for a line that is not the runtime's. */
function readLine(line: string): FaultDetail | null {
  if (!line.startsWith(MARK)) return null;
  const body = line.slice(MARK.length).trim();
  const fn = IN_FUNCTION.exec(body)?.[1];
  const sync = /Error executing sync function /.test(body);
  const script = SCRIPT_BUDGET.exec(body)?.[0];
  if (script) {
    return { fn, sync, kind: 'budget', fault: { stopped: true, text: `${fn ?? 'A call'} ran until the engine cut it off (${script}), which is what an endless loop or a function that calls itself without end does. ${STOPPED_THERE}` } };
  }
  const regex = REGEX_BUDGET.exec(body)?.[0];
  if (regex) {
    return { fn, sync, kind: 'budget', fault: { stopped: true, text: `A regular expression${fn ? ` in ${fn}` : ''} ran until the engine cut it off (${regex}), which is what a pattern that backtracks without end does. ${STOPPED_THERE}` } };
  }
  // The lines that follow a stop are the same stop: there is nothing more to say of it.
  if (ENGINE_GONE.test(body)) return { fn, sync, kind: 'gone', fault: { stopped: true, text: '' } };
  if (fn) {
    // "TypeError: x is undefined" as the browser prints an error, or its message alone.
    const reason = body.slice(body.indexOf(':') + 1).trim().replace(/^[A-Z]\w*Error:\s*/, '');
    return { fn, sync, kind: 'failed', fault: { stopped: false, text: `${fn} failed: ${reason}` } };
  }
  return { sync, kind: 'other', fault: { stopped: false, text: body } };
}

const joined = (args: unknown[]): string => args.map(show).join(' ').replace(/\s+/g, ' ').trim();

/** What one `console.error` of the runtime's means; null for anything that is not the runtime's. */
export function readAppFault(args: unknown[]): AppFault | null {
  if (typeof args[0] !== 'string' || !args[0].startsWith(MARK)) return null;
  return readLine(joined(args))?.fault ?? null;
}

/**
 * Lines the runtime printed, with the engine's words for a stop put into one
 * sentence each and the lines that only repeat it taken out. Every other
 * line is left exactly as it was: the model has always read those.
 */
export function explainEngineStops(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    // A line may arrive with something before the mark ("error: [SoftN] …").
    const at = line.indexOf(MARK);
    const fault = at >= 0 ? readLine(line.slice(at))?.fault : null;
    if (!fault?.stopped) out.push(line);
    else if (fault.text) out.push(fault.text);
  }
  return out;
}

// --- Listening ---------------------------------------------------------------

/** Which of the console's three the line was printed with. */
export type ConsoleLevel = 'error' | 'warn' | 'log';
type ConsoleListener = (args: unknown[], level: ConsoleLevel) => void;

const listeners = new Set<ConsoleListener>();

function tell(args: unknown[], level: ConsoleLevel = 'error'): void {
  for (const listener of [...listeners]) listener(args, level);
}

/**
 * A check in progress. A check renders the app a second time, off the page,
 * so for as long as it lasts two copies of the app print to one console, and
 * a line does not say which of them printed it. What tells them apart is
 * what each can be doing: the check's copy is drawn and left alone, so the
 * only functions it runs are the ones the renderer runs by itself (`_init`,
 * `_onDataChange`, and whatever the markup calls as it is drawn), or the ones
 * `run_app_function` was asked to call. A line about any other function was
 * a person pressing something in the preview.
 */
interface CheckWindow {
  /** Whether the check's own copy of the app may be running this function. */
  mayRun: (fn: string) => boolean;
  /** The check's copy has stopped: an engine stops once, so a second stop is the preview's. */
  ownStop: boolean;
  /** The preview's copy stopped during this check. */
  previewStop: boolean;
}

const windows: CheckWindow[] = [];

/** Whether a line printed while a check is going is the preview's. */
function isThePreviews(args: unknown[], window: CheckWindow): boolean {
  if (typeof args[0] !== 'string' || !args[0].startsWith(MARK)) return false;
  const detail = readLine(joined(args));
  if (!detail) return false;
  const mine = detail.sync || (detail.fn !== undefined && window.mayRun(detail.fn));
  switch (detail.kind) {
    case 'budget':
      // The first stop in a function the check runs is the check's. Any other is the preview's:
      // a function the check never calls, or a second stop (both copies run the same page).
      if (mine && !window.ownStop) {
        window.ownStop = true;
        return false;
      }
      window.previewStop = true;
      return true;
    case 'gone':
      // What follows a stop says no more than the stop did; it is the preview's to hear only
      // when the preview is the one that stopped.
      return window.previewStop && !window.ownStop;
    case 'failed':
      return !mine;
    default:
      return false;
  }
}

/**
 * One wrapper around `console.error`, put on when this module loads and left
 * there: it prints as before, and then tells whoever is listening.
 *
 * The preview used to put its own wrapper on and take it off with every run
 * of the app, and the agent's check does the same for as long as it renders
 * (it collects what the page prints). The two crossed whenever the preview
 * took up a changed file while a check was rendering, which is what happens
 * after every write the agent makes: the check gave the console back to a
 * wrapper the preview had already let go of, and the preview heard nothing
 * from then on. So the wrapper never moves; listeners come and go in a set.
 */
if (typeof console !== 'undefined') {
  const print = console.error;
  console.error = (...args: unknown[]) => {
    print.apply(console, args);
    const window = windows.at(-1);
    if (!window || isThePreviews(args, window)) tell(args);
  };
  // What an app says with console.log and console.warn, for Studio's log. While a check is
  // going these are nobody's: both copies of the app say the same things, and a line does
  // not say which of them said it.
  for (const level of ['log', 'warn'] as const) {
    // eslint-disable-next-line no-console -- not a print of Studio's: the page's own console, kept so that it still prints
    const printed = console[level];
    // eslint-disable-next-line no-console -- the wrapper that hands an app's lines on to Studio's log
    console[level] = (...args: unknown[]) => {
      printed.apply(console, args);
      if (windows.length === 0) tell(args, level);
    };
  }
}

/**
 * What an app's own logic printed (console.log, console.warn, console.error, print), as one
 * line; null for anything else.
 *
 * It reaches the page's console in one of two forms. The engine keeps what a script prints
 * and the runtime prints it after each call, a line at a time, as it was written and at log
 * level whatever the script called (core, runtime/engine-output.ts): one bare string. Where
 * the script is given a console of its own, its lines come under the runtime's mark alone
 * ("[SoftN]", then what it passed). The runtime's own lines begin with the mark and go on,
 * and the tools a page is developed with print under marks of their own; neither is the app.
 */
export function readAppLog(args: unknown[], level: ConsoleLevel): string | null {
  let text: string;
  if (args[0] === MARK && args.length >= 2) text = joined(args.slice(1));
  else if (level === 'log' && args.length === 1 && typeof args[0] === 'string' && !NOT_THE_APPS.test(args[0])) text = args[0].replace(/\s+/g, ' ').trim();
  else return null;
  if (!text) return null;
  return text.length > APP_LINE_CHARS ? text.slice(0, APP_LINE_CHARS) + '…' : text;
}

/** A line under the runtime's mark or a development tool's, or a styled one: not something the app said. */
const NOT_THE_APPS = /^\s*(\[(SoftN|XDB|use[A-Z]|vite|HMR)[^\]]*\]|%c|Download the React DevTools)/;

/** As much of one line of an app's as is copied out: a logged record is not a log line. */
const APP_LINE_CHARS = 300;

/** Be told of everything printed to the page's console, until the function answered is called. */
export function listenToConsoleErrors(listener: ConsoleListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Run `work`, a check, as a check: for as long as it lasts, a line is the
 * listeners' only when it is the preview's (see {@link CheckWindow}).
 * `mayRun` says which functions the check's own copy of the app may be
 * running. The preview used to be told nothing at all while a check was
 * going, so an app that stopped in that second went on saying "Running", and
 * the check reported the person's loop as an error of its own.
 */
export async function duringCheck<T>(mayRun: (fn: string) => boolean, work: () => Promise<T>): Promise<T> {
  const window: CheckWindow = { mayRun, ownStop: false, previewStop: false };
  windows.push(window);
  try {
    return await work();
  } finally {
    windows.splice(windows.indexOf(window), 1);
  }
}

/**
 * For a check that collects the console itself while it renders: whether this
 * line was the preview's. When it was, the listeners have been told, and the
 * check leaves it out of what it reports.
 */
export function heardByPreview(args: unknown[]): boolean {
  const window = windows.at(-1);
  if (!window || !isThePreviews(args, window)) return false;
  tell(args);
  return true;
}

/** What a run will be told at most: the newest lines, each once. */
const KEPT = 8;

/** By project: a run is told what its own project's preview reported, and no other's. */
const noted = new Map<string, string[]>();

/** Keep what the person's preview reported, for the agent's next run in this project. */
export function notePreviewFault(projectId: string | null, fault: AppFault): void {
  if (!fault.text) return;
  const key = projectId ?? '';
  const lines = noted.get(key) ?? [];
  if (lines.includes(fault.text)) return;
  noted.set(key, [...lines, fault.text].slice(-KEPT));
}

/** What the preview of this project reported since it was last asked, and no longer after this. */
export function takePreviewFaults(projectId: string | null): string[] {
  const key = projectId ?? '';
  const lines = noted.get(key) ?? [];
  noted.delete(key);
  return lines;
}
