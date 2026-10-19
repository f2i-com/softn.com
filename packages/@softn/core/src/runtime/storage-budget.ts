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
 * store, with a `QuotaExceededError` the app's code can catch.
 *
 * What is stored is counted once, on the first write, and kept up to date
 * from then on, so a write does not read the whole store back.
 */

type CountedStorage = Pick<Storage, 'length' | 'key' | 'getItem'>;

export class StorageBudget {
  private sizes: Map<string, number> | null = null;
  private total = 0;

  constructor(
    private readonly storage: CountedStorage,
    private readonly prefix: string,
    /** In characters of key and value, which is how the browser counts its own limit. */
    readonly limit: number
  ) {}

  private counted(): Map<string, number> {
    if (this.sizes) return this.sizes;
    const sizes = new Map<string, number>();
    try {
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i);
        if (key?.startsWith(this.prefix)) sizes.set(key, key.length + (this.storage.getItem(key)?.length ?? 0));
      }
    } catch {
      // An unreadable store has nothing of the app's to count.
    }
    this.sizes = sizes;
    this.total = [...sizes.values()].reduce((sum, size) => sum + size, 0);
    return sizes;
  }

  /** Refuse, before it is made, a write of `value` under the full key `key` that would pass the budget. */
  admit(key: string, value: string): void {
    const before = this.counted().get(key) ?? 0;
    const after = this.total - before + key.length + value.length;
    if (after <= this.limit) return;
    throw new DOMException(
      `This app may keep ${Math.round(this.limit / (1024 * 1024))} MB in the browser's storage, and this write would take it past that.`,
      'QuotaExceededError'
    );
  }

  /** A write of `value` under `key` was made. */
  wrote(key: string, value: string): void {
    const sizes = this.counted();
    this.total += key.length + value.length - (sizes.get(key) ?? 0);
    sizes.set(key, key.length + value.length);
  }

  /** `key` was removed. */
  removed(key: string): void {
    const sizes = this.counted();
    this.total -= sizes.get(key) ?? 0;
    sizes.delete(key);
  }
}

/** What an app's `localStorage` may hold. */
export const LOCAL_STORAGE_BUDGET = 1024 * 1024;

/** What an app's records may take of the browser's storage, where it keeps them there. */
export const RECORD_STORAGE_BUDGET = 3 * 1024 * 1024;
