/**
 * A running app that can be handed a newer version of itself.
 *
 * A host that edits an app while it is open (an editor's preview, a runtime
 * with an edit mode) makes one of these, gives it to the renderer
 * (`<SoftNRenderer app={…}>`), and calls `update` each time the app's files
 * have changed. The renderer changes as little as it must and answers what
 * happened: the page was drawn again with the state the app had, the logic
 * was started again with its variables carried over, the app was started
 * clean and why, or the change has a problem and the last version that
 * worked is still on screen.
 *
 * The renderer's own props go through the same door: a host that only ever
 * re-renders `<SoftNRenderer source={…}>` gets the same treatment, and hears
 * the answer through `onUpdate`.
 */

import type { PythonProject } from './vm-adapter';

/** One version of an app, as a renderer runs it: what `composeBundleSource` makes of its files. */
export interface AppRevision {
  /** The composed page: markup, styles and the logic written in it. */
  source: string;
  /** Where the logic's `import` lines are answered from. */
  importResolver?: (path: string) => Promise<string | null>;
  logicBasePath?: string;
  preIncludedLogicPaths?: readonly string[];
  /** The logic, when it is Python. */
  python?: PythonProject;
  /** Where the page does not parse, in its own file and line. */
  parseProblem?: string;
}

/** What of the app an update touched. */
export type AppUpdatePart = 'page' | 'styles' | 'logic' | 'permissions';

export interface AppUpdateResult {
  /**
   * - `unchanged`: there was nothing to do.
   * - `updated`: the running app took the change where it stood. Nothing was
   *   started again: its variables, timers and open page are as they were.
   * - `restarted`: the app was started again. `carried` says whether its
   *   variables were carried into the new start; `reason` says why it had to.
   * - `kept`: the change has a problem, named in `problem`, and the last
   *   version that worked is still showing.
   */
  outcome: 'unchanged' | 'updated' | 'restarted' | 'kept';
  changed: AppUpdatePart[];
  /** restarted: why, in words for the person. */
  reason?: string;
  /** restarted: the app's variables were carried over, and its start-up ran over them. */
  carried?: boolean;
  /** kept: what is wrong with the newest change. */
  problem?: string;
}

export interface LiveApp {
  /**
   * Hand the app a newer version. Answers when it has been dealt with.
   * Versions handed over while one is being dealt with are gathered: the
   * newest is the one applied, and every caller hears what became of it.
   */
  update(revision: AppRevision): Promise<AppUpdateResult>;
  /** Start the app again from nothing, with the version it has: what a person asks for with "Restart". */
  restart(): Promise<AppUpdateResult>;
  /** The version on screen, which is the last one that worked; null before the app has been drawn. */
  readonly shown: AppRevision | null;
  /** The version last handed over, shown or not. */
  readonly wanted: AppRevision | null;
}

/** What the renderer asks of a LiveApp. Not for hosts. */
export interface LiveAppDriver {
  /** The newest thing asked for: its number, the version wanted, and how many restarts have been asked for. */
  job(): { version: number; revision: AppRevision | null; restarts: number };
  /** A version from the renderer's own props: wanted like any other, with nobody waiting on the answer. */
  offer(revision: AppRevision): void;
  subscribe(listener: () => void): () => void;
  /** Everything asked for up to `version` has been dealt with, with this result. */
  settle(version: number, result: AppUpdateResult): void;
  /** `revision` is on screen now. */
  show(revision: AppRevision | null): void;
}

const DRIVER = Symbol.for('softn.liveApp.driver');

/** Whether two versions are the same to a renderer: the same text from the same places. */
export function sameRevision(a: AppRevision | null, b: AppRevision | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.source === b.source &&
    a.importResolver === b.importResolver &&
    a.logicBasePath === b.logicBasePath &&
    a.preIncludedLogicPaths === b.preIncludedLogicPaths &&
    a.python === b.python &&
    a.parseProblem === b.parseProblem
  );
}

export interface LiveAppOptions {
  /** The version to start with, for a host that does not give the renderer a `source`. */
  initial?: AppRevision;
  /**
   * How long to wait for more after a version is handed over, in
   * milliseconds, before the app is given the newest: a writer that saves
   * ten files in a row is one update. None by default; versions that arrive
   * while one is being dealt with are gathered either way.
   */
  gatherMs?: number;
}

export function createLiveApp(options: LiveAppOptions = {}): LiveApp {
  let wanted: AppRevision | null = options.initial ?? null;
  let shown: AppRevision | null = null;
  let version = 0;
  let restarts = 0;
  let waiting: Array<{ upTo: number; resolve: (result: AppUpdateResult) => void }> = [];
  const listeners = new Set<() => void>();
  let gathering: ReturnType<typeof setTimeout> | null = null;
  const gatherMs = Math.max(0, options.gatherMs ?? 0);

  const tell = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const notify = (now: boolean): void => {
    if (gatherMs === 0 || now) {
      if (gathering !== null) {
        clearTimeout(gathering);
        gathering = null;
      }
      tell();
      return;
    }
    if (gathering !== null) clearTimeout(gathering);
    gathering = setTimeout(() => {
      gathering = null;
      tell();
    }, gatherMs);
  };
  const ask = (now: boolean): Promise<AppUpdateResult> => {
    const upTo = ++version;
    return new Promise((resolve) => {
      waiting.push({ upTo, resolve });
      notify(now);
    });
  };

  const driver: LiveAppDriver = {
    job: () => ({ version, revision: wanted, restarts }),
    offer: (revision) => {
      if (sameRevision(wanted, revision)) return;
      wanted = revision;
      version++;
      notify(true);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    settle: (upTo, result) => {
      const done = waiting.filter((entry) => entry.upTo <= upTo);
      waiting = waiting.filter((entry) => entry.upTo > upTo);
      for (const entry of done) entry.resolve(result);
    },
    show: (revision) => {
      shown = revision;
    },
  };

  const app: LiveApp = {
    update: (revision) => {
      wanted = revision;
      return ask(false);
    },
    restart: () => {
      restarts++;
      return ask(true);
    },
    get shown() {
      return shown;
    },
    get wanted() {
      return wanted;
    },
  };
  Object.defineProperty(app, DRIVER, { value: driver });
  return app;
}

/** The renderer's side of a LiveApp. */
export function liveAppDriver(app: LiveApp): LiveAppDriver {
  const driver = (app as unknown as Record<symbol, LiveAppDriver | undefined>)[DRIVER];
  if (!driver) throw new TypeError('A live app is made with createLiveApp()');
  return driver;
}
