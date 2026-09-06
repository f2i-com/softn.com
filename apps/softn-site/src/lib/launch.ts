/**
 * Pressing Play.
 *
 * Two things happen: the visitor goes to the runtime, and the directory is
 * told an app was played. Only the first matters to the visitor, and the
 * second must never delay it. Play used to navigate in the run-count
 * request's `.finally()`, so a `/runs` endpoint that was slow, blocked or
 * offline was a Play button that did nothing for as long as the request
 * stayed pending — a working app that looked unlaunchable because of a
 * counter. The count is started, not awaited; `keepalive` lets it finish
 * after the page has gone.
 *
 * What is counted is the click, not a runtime that came up. Telling those
 * apart needs a signal from the runtime after the app's first usable frame,
 * which this directory does not yet collect.
 */

import { recordRun } from './api';
import { runtimeAppUrl } from './appUrls';

export interface LaunchDeps {
  record: (slug: string) => void;
  go: (url: string) => void;
}

const browser: LaunchDeps = {
  record: recordRun,
  go: (url) => window.location.assign(url),
};

export function launchApp(slug: string, deps: LaunchDeps = browser): void {
  const to = runtimeAppUrl(slug);
  try {
    deps.record(slug);
  } catch {
    // The count is optional; the launch is not.
  }
  deps.go(to);
}
