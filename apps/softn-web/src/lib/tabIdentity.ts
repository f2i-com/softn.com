/**
 * Which open tab a bundle belongs to.
 *
 * A tab's name is the manifest's `name`, chosen by the bundle for itself, and
 * it is for the user to read. It is not a key. The launcher used to search
 * open tabs by name when a bundle arrived, and activate the first one it
 * found: two builds of the same app, or two unrelated bundles both called
 * Notes, selected the tab that was already running, and the person who had
 * just opened an update was shown the old build with nothing to say so.
 *
 * Reuse is decided on identity — the digest of the bundle's bytes, which is
 * also what its data and its grants belong to — and a placeholder is claimed
 * by the id its creator was given, never by what it happens to be called.
 * Two same-name apps therefore coexist as two tabs, and the bar tells them
 * apart with their version where the name alone would not.
 */

export interface TabLike {
  id: string;
  name: string;
  /** The bundle's digest; absent on a placeholder, which has no bundle yet. */
  appId?: string;
  /** Empty on a placeholder that is still loading. */
  source: string;
  version?: string;
}

/** The tab already running these exact bytes, if any. */
export function findRunningTab<T extends TabLike>(tabs: readonly T[], origin: string): T | undefined {
  return tabs.find((t) => Boolean(t.source) && t.appId === origin);
}

/** The placeholder this load was given, if it is still there and still empty. */
export function findPlaceholder<T extends TabLike>(tabs: readonly T[], placeholderId: string | undefined): T | undefined {
  if (!placeholderId) return undefined;
  return tabs.find((t) => t.id === placeholderId && !t.source);
}

/**
 * The tab a `/app/<name>` address refers to.
 *
 * The address carries a name, which can match more than one tab; the one
 * being looked at wins, so going back and forward between two Notes tabs does
 * not flip to the other one. Otherwise the first match, as before.
 */
export function findTabForUrlName<T extends TabLike>(tabs: readonly T[], name: string, activeId: string | null): T | undefined {
  const active = activeId ? tabs.find((t) => t.id === activeId) : undefined;
  if (active && active.name === name) return active;
  return tabs.find((t) => t.name === name);
}

/**
 * What to call a tab where another open tab has the same name.
 *
 * The version is appended only when it tells the two apart; two builds that
 * carry the same version string are still two tabs, just not distinguishable
 * by label, and a label that pretends otherwise would be worse than none.
 */
export function displayNameFor<T extends TabLike>(tab: T, tabs: readonly T[]): string {
  const twins = tabs.filter((t) => t.name === tab.name);
  if (twins.length < 2 || !tab.version) return tab.name;
  const versions = new Set(twins.map((t) => t.version));
  return versions.size > 1 ? `${tab.name} v${tab.version}` : tab.name;
}
