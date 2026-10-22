/**
 * What is being downloaded to run an app, while a host waits for it: the
 * app's bundle, the script engine, the torch package and the components a
 * page fetches on demand, as core's load-progress list has them.
 *
 * Two forms. `panel` sits on a loading screen, under its spinner: a bar for
 * the bytes and one line a download. `bar` is a thin line along the top of an
 * app that is already drawn, with a small label at its right ("Script engine
 * · 34%"), for what is still arriving after its first draw (a first visit's
 * engine, a later page's 3D): the app is on screen and works as each piece
 * arrives, so it is told and not shown a screen.
 *
 * Neither shows for a load that is over quickly: the panel after `delayMs`
 * on screen, the bar for a download that has gone on that long. A load from
 * the cache is done before either would appear.
 */

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { loadProgressItems, subscribeLoadProgress, type LoadProgressItem } from '@softn/core';

/** What each on-demand feature of @softn/components is, as a person would name it. */
export const FEATURE_LABELS: Readonly<Record<string, string>> = {
  controls: 'Form controls',
  feedback: 'Dialogs and alerts',
  data: 'Tables',
  display: 'Display components',
  navigation: 'Tabs and menus',
  charts: 'Charts',
  scene3d: '3D',
  editors: 'Editors',
  smart: 'Smart views',
  media: 'Camera and QR codes',
  animation: 'Animation',
  pickers: 'Date and colour pickers',
  games: 'Game components',
};

/** How a download is named on screen. */
export function describeDownload(item: LoadProgressItem): string {
  switch (item.kind) {
    case 'engine':
      return 'Script engine';
    case 'torch':
      return 'Python torch package';
    case 'bundle':
      return item.name || 'The app';
    default:
      return (item.name && FEATURE_LABELS[item.name]) ?? item.name ?? 'Components';
  }
}

/** A size as a person reads it: kilobytes below a megabyte, megabytes to one place above. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What a download's line says after its name. */
export function downloadDetail(item: LoadProgressItem): string {
  if (item.failed) return 'Failed';
  if (item.total) return `${formatBytes(Math.min(item.loaded, item.total))} of ${formatBytes(item.total)}`;
  if (item.done) return 'Ready';
  return item.loaded > 0 ? formatBytes(item.loaded) : 'Loading…';
}

/**
 * The share of the bytes that have arrived, over the downloads whose size is
 * known, from 0 to 1; null when none of them says its size.
 */
export function downloadedShare(items: readonly LoadProgressItem[]): number | null {
  let loaded = 0;
  let total = 0;
  for (const item of items) {
    if (!item.total) continue;
    total += item.total;
    loaded += item.done ? item.total : Math.min(item.loaded, item.total);
  }
  return total > 0 ? loaded / total : null;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * The downloads a form shows, and whether it shows at all yet. The panel
 * counts what started since it appeared, done or not, so its bar does not
 * jump back as a piece finishes; the bar counts what is still arriving.
 */
export function visibleDownloads(
  items: readonly LoadProgressItem[],
  variant: 'panel' | 'bar',
  since: number,
  at: number,
  delayMs: number
): { items: LoadProgressItem[]; show: boolean; nextCheck: number | null } {
  const shown = variant === 'panel' ? items.filter((item) => !item.done || item.startedAt >= since) : items.filter((item) => !item.done);
  const active = shown.filter((item) => !item.done);
  if (active.length === 0) return { items: shown, show: false, nextCheck: null };
  // From the oldest download still arriving; for a panel, from when it
  // appeared if that was sooner, so pieces that each come quickly but follow
  // one another are shown, and a screen that replaces another (SoftN Web's
  // opening tab, then its starting app) does not wait out the delay again.
  const oldest = Math.min(...active.map((item) => item.startedAt));
  const from = variant === 'panel' ? Math.min(since, oldest) : oldest;
  const due = from + delayMs;
  return { items: shown, show: at >= due, nextCheck: at >= due ? null : due - at };
}

export const LOAD_PROGRESS_STYLES = `
  .softn-load-panel {
    width: min(320px, 100%);
    display: grid;
    gap: 6px;
    font-size: 12.5px;
    line-height: 1.35;
    text-align: left;
  }
  .softn-load-track {
    position: relative;
    height: 4px;
    border-radius: 2px;
    overflow: hidden;
    background: color-mix(in srgb, currentColor 16%, transparent);
  }
  .softn-load-fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: 2px;
    background: currentColor;
    opacity: 0.75;
    transition: width 120ms linear;
  }
  .softn-load-fill[data-indeterminate] {
    width: 30%;
    animation: softn-load-sweep 1.2s ease-in-out infinite;
  }
  @keyframes softn-load-sweep {
    from { left: -30%; }
    to { left: 100%; }
  }
  .softn-load-line {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    opacity: 0.72;
  }
  .softn-load-line[data-done] { opacity: 0.5; }
  .softn-load-line span:last-child { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .softn-load-bar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 2;
    pointer-events: none;
  }
  .softn-load-bar-track {
    position: relative;
    height: 3px;
    overflow: hidden;
    background: rgba(53, 224, 192, 0.18);
  }
  .softn-load-bar .softn-load-fill { background: #35e0c0; opacity: 1; }
  .softn-load-pill {
    position: absolute;
    top: 9px;
    right: 10px;
    padding: 3px 10px;
    border-radius: 999px;
    background: rgba(16, 19, 23, 0.82);
    color: #f2f0ec;
    font: 500 12px/1.4 "IBM Plex Sans", system-ui, -apple-system, sans-serif;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
  }
  .softn-load-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  @media (prefers-reduced-motion: reduce) {
    .softn-load-fill { transition: none; }
    .softn-load-fill[data-indeterminate] { animation: none; left: 0; width: 100%; opacity: 0.35; }
  }
`;

export interface LoadProgressProps {
  variant?: 'panel' | 'bar';
  /** How long a load goes on before it is shown, in milliseconds. */
  delayMs?: number;
  /**
   * For the bar: how far down its positioned container it runs, as CSS, so
   * it sits under whatever the host draws above the app (a permission bar).
   */
  top?: string;
}

export function LoadProgress({ variant = 'panel', delayMs = 400, top }: LoadProgressProps): React.ReactElement | null {
  const items = useSyncExternalStore(subscribeLoadProgress, loadProgressItems, loadProgressItems);
  const [since] = useState(now);
  const [, recheck] = useState(0);
  const { items: shown, show, nextCheck } = visibleDownloads(items, variant, since, now(), delayMs);
  // Drawn again when the first download crosses the delay, with nothing else
  // to wake it.
  useEffect(() => {
    if (nextCheck === null) return;
    const timer = setTimeout(() => recheck((n) => n + 1), nextCheck + 1);
    return () => clearTimeout(timer);
  }, [nextCheck]);
  if (!show) return null;

  const share = downloadedShare(shown);
  const active = shown.filter((item) => !item.done);
  const summary = active.map((item) => `${describeDownload(item)}, ${downloadDetail(item)}`).join('; ');
  const percent = share === null ? undefined : Math.round(share * 100);
  const track = (
    <div
      className={variant === 'panel' ? 'softn-load-track' : 'softn-load-bar-track'}
      role="progressbar"
      aria-label="Downloading what this app needs"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={summary}
    >
      <div
        className="softn-load-fill"
        data-indeterminate={share === null ? '' : undefined}
        style={share === null ? undefined : { width: `${percent}%` }}
      />
    </div>
  );

  if (variant === 'bar') {
    // A word with the line: an app that draws its screen from its script's
    // state is blank until the engine arrives, and a line alone over a blank
    // page says too little. Read out by the progress bar's own text.
    const lead = active.find((item) => item.total) ?? active[0];
    const label = lead.total
      ? `${describeDownload(lead)} · ${Math.round((Math.min(lead.loaded, lead.total) / lead.total) * 100)}%`
      : `${describeDownload(lead)}…`;
    return (
      <div className="softn-load-bar" style={top ? { top } : undefined}>
        <style dangerouslySetInnerHTML={{ __html: LOAD_PROGRESS_STYLES }} />
        {track}
        <div className="softn-load-pill" aria-hidden="true">
          {label}
        </div>
      </div>
    );
  }
  return (
    <div className="softn-load-panel">
      <style dangerouslySetInnerHTML={{ __html: LOAD_PROGRESS_STYLES }} />
      {track}
      {shown.map((item) => (
        <div className="softn-load-line" key={item.id} data-done={item.done ? '' : undefined}>
          <span>{describeDownload(item)}</span>
          <span>{downloadDetail(item)}</span>
        </div>
      ))}
    </div>
  );
}
