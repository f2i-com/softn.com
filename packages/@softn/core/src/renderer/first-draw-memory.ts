/**
 * What an app's first screen waited for the last time it opened, so the next
 * open can start it before the page has been read.
 *
 * A page's first draw waits for the light on-demand components its first
 * screen names (registry.firstDrawLoads), and those loads cannot start until
 * the page is parsed: the app's bundle fetched, read and composed first. An
 * app opens the same way each time, so the renderer writes down which of
 * those components it waited for, under the app's id, and a host that knows
 * the id before it has the page (the standalone shell, from its
 * configuration; SoftN Web, from the bundle's digest) starts them then, while
 * the bundle is still on its way.
 *
 * One record per app per page load, from the first page the app draws, and
 * it replaces the one before rather than adding to it: an app that stopped
 * using a component stops having it started. A record that is wrong costs a
 * component loaded early; nothing waits on it. Kept in localStorage, one map
 * of at most {@link MAX_APPS} apps, the least recently opened dropped first;
 * a browser that refuses storage remembers nothing and loses nothing.
 */

import { getDefaultRegistry, type ComponentRegistry } from './registry';

const STORAGE_KEY = 'softn:first-draw';
/** The apps remembered at most. */
export const MAX_APPS = 50;

interface Remembered {
  names: string[];
  /** When the app last opened, which decides what is dropped first. */
  at: number;
}

/** The apps recorded in this page load: each records once, from its first page. */
const recorded = new Set<string>();

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(): Record<string, Remembered> {
  try {
    const parsed = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, Remembered>) : {};
  } catch {
    return {};
  }
}

/**
 * Write down the components `appId`'s first draw waited for: `names` as
 * registry.firstDrawNames gives them. Only the first call for an app in a
 * page load counts; the record replaces the app's last one, and an empty
 * list removes it.
 */
export function rememberFirstDraw(appId: string, names: readonly string[]): void {
  if (recorded.has(appId)) return;
  recorded.add(appId);
  const memory = read();
  if (names.length === 0 && !memory[appId]) return;
  if (names.length === 0) delete memory[appId];
  else memory[appId] = { names: [...names].sort(), at: Date.now() };
  const kept = Object.entries(memory)
    .filter(([, entry]) => entry && Array.isArray(entry.names) && typeof entry.at === 'number')
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_APPS);
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Full or refused: the next open starts its components when it reads its page.
  }
}

/** The components `appId`'s first draw waited for last time, or none. */
export function recallFirstDraw(appId: string): string[] {
  const entry = read()[appId];
  return Array.isArray(entry?.names) ? entry.names.filter((name): name is string => typeof name === 'string') : [];
}

/**
 * Start loading what `appId`'s first draw waited for last time. For a host,
 * as soon as it knows which app it is opening; the renderer joins the loads
 * when it gets to the page. Never rejects; starts nothing for an app it has
 * no record of.
 */
export function preloadRememberedFirstDraw(appId: string, registry: ComponentRegistry = getDefaultRegistry()): void {
  const names = recallFirstDraw(appId);
  if (names.length > 0) void registry.preload(registry.firstDrawNames(names));
}

/** For tests: forget which apps have recorded in this page load. */
export function resetFirstDrawMemoryForTests(): void {
  recorded.clear();
}
