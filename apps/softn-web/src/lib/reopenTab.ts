/**
 * An open app opened afresh in the tab it is in: what the runtime's editor
 * asks for when a change cannot be handed to the running app (its manifest,
 * what it asks permission for), and for "Restart" on a page a link put on
 * screen. The tab stays, empty, and the open fills it from the saved bundle,
 * so whatever is beside it stays beside it.
 *
 * The app is the app it was: one from the directory is still the
 * directory's, with its page, its address and its storage there, and one
 * opened by a link still says where it came from, which is what a reload
 * fetches it by.
 */

import type { CachedApp } from './appCache';
import { openBundle, type OpenBundleHost, type OpenTab } from './openBundle';

/**
 * `host.setOpenTabs` must be known to `host.tabs()` as it is called: the tab
 * the open finds is the empty one put there a line before.
 */
export async function reopenTab(
  host: OpenBundleHost,
  tab: OpenTab,
  record: CachedApp,
  options: { initialPage?: string; isForeground?: () => boolean } = {}
): Promise<boolean> {
  const tabId = tab.id;
  tab.importResolver?.dispose();
  tab.assetResolver?.dispose();
  const directorySlug = tab.directorySlug ?? record.directorySlug;
  host.setOpenTabs((tabs) =>
    tabs.map((t) => (t.id === tabId ? { id: tabId, name: tab.name, icon: tab.icon, source: '', initialPage: options.initialPage, directorySlug } : t))
  );
  const opened = await openBundle(host, {
    data: record.bundleData,
    fileName: `${record.name}.softn`,
    cachedAppId: record.id,
    initialPage: options.initialPage,
    directorySlug,
    // Opened by a link when it was: someone else's still, with nothing of the person's laid over it.
    fromLink: Boolean(tab.bundleUrl) || undefined,
    placeholderId: tabId,
    isForeground: options.isForeground,
  });
  if (opened === null) {
    // An open that failed before it took the empty tab leaves it to whoever put it there.
    host.setOpenTabs((tabs) => tabs.filter((t) => !(t.id === tabId && !t.source)));
    return false;
  }
  // Where it was fetched from is the caller's to know, as it was when it was first opened.
  if (tab.bundleUrl) host.setOpenTabs((tabs) => tabs.map((t) => (t.id === tabId && t.source ? { ...t, bundleUrl: tab.bundleUrl } : t)));
  return true;
}
