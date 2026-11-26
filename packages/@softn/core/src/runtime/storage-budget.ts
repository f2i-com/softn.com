/**
 * How much of the browser's storage one app may hold.
 *
 * The browser gives a site one store, about five megabytes, and the host and
 * every app on the site share it. An app's keys are its own (prefixed with
 * its id), but its size was not: a bundle with no permissions could fill the
 * store, and every write after it failed — the host's, and every other
 * app's records — until someone cleared that app's data. Each app now has a
 * budget, counted by what it has stored under its own prefix: a write that
 * would take it past the budget is refused as the browser refuses a full
 * store, with a `QuotaExceededError`. The host reads that name, and the
 * person is told. The app's code can catch the failure and not the reason:
 * the engine gives a script its own words for a host call that threw.
 *
 * What is stored is counted on the first write and kept up to date from
 * then on, so a write does not read the whole store back. It is counted
 * again when someone else has written under the prefix since (see
 * `changes`): each engine keeps a budget of its own, and two of one app, in
 * two views or two tabs, each held their own writes to the whole budget and
 * never saw the other's.
 */

type CountedStorage = Pick<Storage, 'length' | 'key' | 'getItem'>;

/**
 * How many times what a store holds under a prefix has been changed, as far
 * as this page has heard: by a budget of that prefix here (`wrote`,
 * `removed`), or in another tab (the browser's `storage` event, which says
 * so in every tab but the one that wrote). A budget whose count was made
 * before the last change by anyone else counts again at its next use, so
 * an app open twice is held to one budget, at the cost of a count where
 * the two take turns and of none where there is one.
 *
 * Two tabs that write in the same instant still each see only their own
 * (a tab hears of the other's write when its own script has finished), by
 * no more than each wrote in that moment; the next write of either counts
 * both.
 */
const changes = new WeakMap<object, Map<string, number>>();

function changesUnder(storage: object): Map<string, number> {
  let prefixes = changes.get(storage);
  if (!prefixes) changes.set(storage, (prefixes = new Map()));
  return prefixes;
}

/** Another tab wrote to the store: every prefix its key is under has changed (a `null` key is the store cleared). */
function heardFromAnotherTab(event: StorageEvent): void {
  const prefixes = event.storageArea ? changes.get(event.storageArea) : undefined;
  if (!prefixes) return;
  for (const [prefix, count] of prefixes) {
    if (event.key === null || event.key.startsWith(prefix)) prefixes.set(prefix, count + 1);
  }
}

let hearing = false;

/** Listen, once, for other tabs' writes to the page's own store; a store of another kind has no other tab. */
function hearOtherTabs(storage: CountedStorage): void {
  if (hearing) return;
  try {
    if (typeof localStorage === 'undefined' || storage !== localStorage || typeof addEventListener !== 'function') return;
    addEventListener('storage', heardFromAnotherTab);
    hearing = true;
  } catch {
    // A frame with no store of its own (reading `localStorage` throws) shares none with another tab.
  }
}

export class StorageBudget {
  private sizes: Map<string, number> | null = null;
  private total = 0;
  /** The change of the prefix (`changes`) the count was last brought up to. */
  private countedAt = 0;

  constructor(
    private readonly storage: CountedStorage,
    private readonly prefix: string,
    /** In characters of key and value, which is how the browser counts its own limit. */
    readonly limit: number,
    /**
     * Which keys under the prefix are this budget's, by what follows the prefix, where another
     * owner's keys can begin with it too (the default XDB store's `xdb:` begins every app's).
     */
    private readonly owns?: (rest: string) => boolean
  ) {
    const prefixes = changesUnder(storage);
    if (!prefixes.has(prefix)) prefixes.set(prefix, 0);
    hearOtherTabs(storage);
  }

  private counted(): Map<string, number> {
    const change = changesUnder(this.storage).get(this.prefix) ?? 0;
    if (this.sizes && this.countedAt === change) return this.sizes;
    const sizes = new Map<string, number>();
    try {
      const length = this.storage.length;
      for (let i = 0; i < length; i++) {
        const key = this.storage.key(i);
        if (!key?.startsWith(this.prefix) || (this.owns && !this.owns(key.slice(this.prefix.length)))) continue;
        sizes.set(key, key.length + (this.storage.getItem(key)?.length ?? 0));
      }
    } catch {
      // An unreadable store has nothing of the app's to count.
    }
    this.sizes = sizes;
    this.total = [...sizes.values()].reduce((sum, size) => sum + size, 0);
    this.countedAt = change;
    return sizes;
  }

  /** This budget changed what is stored: the others of its prefix count again, and this one is up to date. */
  private changed(): void {
    const prefixes = changesUnder(this.storage);
    this.countedAt = (prefixes.get(this.prefix) ?? 0) + 1;
    prefixes.set(this.prefix, this.countedAt);
  }

  /**
   * The longest value `key` may be given, with `reserve` of the budget kept
   * back. Within the budget; or, for an app that holds more than it from
   * before there was one, a value that holds no more than now: a smaller
   * rewrite, the one way out, is never refused.
   */
  room(key: string, reserve = 0): number {
    const before = this.counted().get(key) ?? 0;
    return Math.max(this.limit - reserve, this.total) - (this.total - before) - key.length;
  }

  /**
   * Refuse, before it is made, a write of `value` under the full key `key`
   * that would pass the budget, or the budget less `reserve` (what peers send
   * may not take the room an app's own writes need).
   *
   * Not before what is stored has been counted again: the host removes an
   * app's keys without a word to its budget (clearing its data, in this
   * page, where no `storage` event says so), and the app was then refused
   * writes that fitted until the page was loaded again.
   */
  admit(key: string, value: string, reserve = 0): void {
    if (value.length <= this.room(key, reserve)) return;
    this.sizes = null;
    if (value.length <= this.room(key, reserve)) return;
    throw new DOMException(
      reserve > 0
        ? `This app may keep ${megabytes(this.limit)} MB in the browser's storage, of which what peers send may take ${megabytes(this.limit - reserve)} MB, and this write would take it past that.`
        : `This app may keep ${megabytes(this.limit)} MB in the browser's storage, and this write would take it past that.`,
      'QuotaExceededError'
    );
  }

  /** A write of `value` under `key` was made. */
  wrote(key: string, value: string): void {
    const sizes = this.counted();
    this.total += key.length + value.length - (sizes.get(key) ?? 0);
    sizes.set(key, key.length + value.length);
    this.changed();
  }

  /** `key` was removed. */
  removed(key: string): void {
    const sizes = this.counted();
    this.total -= sizes.get(key) ?? 0;
    sizes.delete(key);
    this.changed();
  }
}

/** A budget in megabytes, to a tenth, as the messages give it. */
export function megabytes(characters: number): number {
  return Math.round((characters / (1024 * 1024)) * 10) / 10;
}

/** What an app's `localStorage` may hold. */
export const LOCAL_STORAGE_BUDGET = 1024 * 1024;

/** What an app's records may take of the browser's storage, where it keeps them there. */
export const RECORD_STORAGE_BUDGET = 3 * 1024 * 1024;

/**
 * What of the record budget peer sync leaves for the app's own writes. A
 * room's records filled the whole budget, and the person's next edit here
 * was refused, by records any peer of the room could send.
 */
export const PEER_RECORD_HEADROOM = 512 * 1024;
