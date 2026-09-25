/**
 * Consent, the part every host shares: what a declaration asks for, the
 * same bundle with all of it withheld, how an Allow is remembered, and what
 * an update asks for that the build before it did not.
 *
 * The web runtime, the desktop loader and the single-app shell each used to
 * carry their own copy of some of this. They run the same bundles under the
 * same rule — on screen at once, every declared capability withheld until
 * the person allows it — so the rule lives here once. The UI that asks is
 * `PermissionBar` and `PermissionPrompt`, beside this file.
 *
 * Only `inspectDeclaration` is read from core: a host that mocks core for its
 * tests (the loader's do) needs nothing else from it to load this module.
 */

import { inspectDeclaration, type PermissionConfig } from '@softn/core';

/** Every capability a declaration asks for — the list the bar names and a grant covers. */
export function requestedCapabilities(config: PermissionConfig): string[] {
  return inspectDeclaration(config).requested;
}

/**
 * The same bundle, with everything it declared withheld.
 *
 * This is what the runtime is handed while the consent bar is up, so the app
 * renders and runs but every softn.* capability fails closed. Two details are
 * load-bearing:
 *
 * `permissions` is an empty object, never null. Both sync gates refuse a null
 * config outright, but an empty object is still what the state means, and it
 * selects the right refusal: a null config makes the runtime say "this bundle
 * ships no permission.json", which is false here and is advice for an author
 * rather than for the person looking at the bar. It also reads to the device
 * components as "no host is enforcing".
 *
 * `consentPending` only changes what a refusal says: "you have not allowed this
 * yet" rather than an instruction to edit a file the author already wrote.
 */
export function withheldPermissions(declared: PermissionConfig): PermissionConfig {
  return Object.freeze({
    app: declared.app,
    permissions: Object.freeze({}),
    consentPending: true,
  }) as PermissionConfig;
}

// ── Remembering an Allow ───────────────────────────────────────────────────

/** The prefix a host's grants are kept under unless it names its own. */
export const DEFAULT_GRANT_PREFIX = 'softn:grant:';

/**
 * The storage key an Allow for this app and this declaration is kept under.
 *
 * `identity` is what the host knows the app by — the loader's content digest
 * of the package, say. The declaration is part of the key as written, not
 * only through the digest: whatever else changes about how a package is
 * identified, a grant never answers a request it was not shown, and a package
 * that asks for one more host asks again.
 *
 * `prefix` keeps each host's grants to itself; a host that already has grants
 * on disk passes the prefix they were written under so they still count.
 */
export function grantKey(identity: string, declared: PermissionConfig, prefix: string = DEFAULT_GRANT_PREFIX): string {
  return `${prefix}${identity}:${JSON.stringify(declared)}`;
}

/** Whether an Allow was remembered under this key. Storage that cannot be read remembers nothing. */
export function hasSavedGrant(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'allowed';
  } catch {
    return false;
  }
}

/**
 * Remember an Allow. A write that fails does not undo it: the running app
 * keeps what was allowed, and the next open asks again.
 */
export function saveGrant(key: string): void {
  try {
    localStorage.setItem(key, 'allowed');
  } catch {
    // Storage unavailable or full; the grant still applies to this run.
  }
}

/**
 * Whether a recorded grant covers everything a declaration asks for.
 *
 * For a host that records grants as a capability map (the web runtime keeps
 * one on each cached app). `=== true`, not truthy: the map comes off disk
 * unchecked. A declaration that asks for nothing is covered by anything.
 */
export function grantCovers(granted: Readonly<Record<string, unknown>> | undefined, requested: readonly string[]): boolean {
  if (requested.length === 0) return true;
  if (!granted) return false;
  return requested.every((capability) => granted[capability] === true);
}

/** The capability map a grant for `requested` is recorded as. */
export function grantRecord(requested: readonly string[]): Record<string, boolean> {
  const record: Record<string, boolean> = {};
  for (const capability of requested) record[capability] = true;
  return record;
}

// ── What an update asks for ─────────────────────────────────────────────────

/**
 * The build of this app opened before this one. Grants belong to one build,
 * so a new build always asks again. That is right, and it is also where a
 * capability can slip past: someone who approved "the internet" for v1 reads
 * the v2 bar, sees "the internet and your files", and presses Allow the way
 * they did last time. The bar says what changed.
 */
export interface PreviousBuild {
  version: string;
  capabilities: string[];
}

export interface CapabilityChange {
  /** Asked for now, not before. */
  added: string[];
  /** Asked for before, not now. */
  removed: string[];
}

export function diffCapabilities(current: readonly string[], previous: readonly string[]): CapabilityChange {
  return {
    added: current.filter((c) => !previous.includes(c)),
    removed: previous.filter((c) => !current.includes(c)),
  };
}
