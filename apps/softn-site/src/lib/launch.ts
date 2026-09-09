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
 * A linked app (one that lives on its own site) opens in a new tab instead:
 * the directory stays where it was, and the count is the same launch.
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
  /** Open in a new tab. Falls back to `go` when absent, so a caller that cannot open tabs still launches. */
  open?: (url: string) => void;
}

/** What launching needs to know about an app: its slug, and where it plays if not here. */
export interface Launchable {
  slug: string;
  external?: { url: string } | null;
}

const browser: LaunchDeps = {
  record: recordRun,
  go: (url) => window.location.assign(url),
  open: (url) => {
    // Called from a click, so a popup blocker lets it through. With
    // `noopener` the call returns null by design, so its result says nothing
    // about whether a tab opened; there is no fallback to a same-tab
    // navigation, which would open the site twice when it did.
    window.open(url, '_blank', 'noopener,noreferrer');
  },
};

export function launchApp(app: Launchable | string, deps: LaunchDeps = browser): void {
  const slug = typeof app === 'string' ? app : app.slug;
  const external = typeof app === 'string' ? null : (app.external ?? null);
  try {
    deps.record(slug);
  } catch {
    // The count is optional; the launch is not.
  }
  if (external) {
    (deps.open ?? deps.go)(external.url);
    return;
  }
  deps.go(runtimeAppUrl(slug));
}
