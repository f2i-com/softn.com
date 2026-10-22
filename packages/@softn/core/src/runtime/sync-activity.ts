/**
 * Which apps are open and on screen, for peer-to-peer sync: an app's rooms
 * are connected while its host shows it, wait while it is behind another
 * (SoftN Web keeps every open app mounted, one tab on screen at a time), and
 * close when it closes.
 *
 * Kept apart from xdb-sync.ts, which carries yjs and is loaded only by an
 * app that syncs: the renderer reports from its first draw, before any app
 * has started a room, and the sync module asks here when it starts one, so
 * an app started while hidden waits too.
 */

export type AppActivity = 'shown' | 'hidden' | 'closed';

/** Each mounted view of an app, by app id ('' for an app with none), and whether its host shows it. */
const views = new Map<string, Map<object, boolean>>();
/** How many times each app has closed. */
const closings = new Map<string, number>();
const listeners = new Set<(appKey: string, activity: AppActivity) => void>();

const keyOf = (appId: string | undefined): string => appId ?? '';

function emit(key: string, activity: AppActivity): void {
  for (const listener of [...listeners]) listener(key, activity);
}

/**
 * Whether `appId` is on screen: when any view of it is shown, or when no host
 * has mounted it (a script run without a renderer syncs as it always has).
 */
export function isAppShown(appId: string | undefined): boolean {
  const mounted = views.get(keyOf(appId));
  if (!mounted) return true;
  for (const shown of mounted.values()) if (shown) return true;
  return false;
}

/**
 * How many times `appId` has closed. A room asked for while the sync module
 * loads is not started if this has moved by the time it has: the app that
 * asked is gone.
 */
export function appClosings(appId: string | undefined): number {
  return closings.get(keyOf(appId)) ?? 0;
}

/** Be told when an app is shown, hidden or closed. Returns the way to stop. */
export function onAppActivity(listener: (appKey: string, activity: AppActivity) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface AppView {
  /** Say whether the host shows this view. */
  setShown(shown: boolean): void;
  /** The view is gone; the app closes with its last one. */
  close(): void;
}

/**
 * A host's view of `appId`. The app is on screen while any of its views is,
 * so two views of one app do not undo each other, and it closes when the
 * last one does.
 */
export function openAppView(appId: string | undefined, shown = true): AppView {
  const key = keyOf(appId);
  const token = {};
  const wasShown = isAppShown(appId);
  let mounted = views.get(key);
  if (!mounted) views.set(key, (mounted = new Map()));
  mounted.set(token, shown);
  const report = (before: boolean) => {
    const after = isAppShown(appId);
    if (after !== before) emit(key, after ? 'shown' : 'hidden');
  };
  report(wasShown);
  let open = true;
  return {
    setShown(next) {
      if (!open || mounted.get(token) === next) return;
      const before = isAppShown(appId);
      mounted.set(token, next);
      report(before);
    },
    close() {
      if (!open) return;
      open = false;
      const before = isAppShown(appId);
      mounted.delete(token);
      if (mounted.size > 0) {
        report(before);
        return;
      }
      views.delete(key);
      closings.set(key, appClosings(appId) + 1);
      emit(key, 'closed');
    },
  };
}
