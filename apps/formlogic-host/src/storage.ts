/**
 * The failed-save alert's look, in the theme the app is drawn in: the
 * provider writes its tokens on this document (see appTheme.ts). It was a
 * fixed pale orange with dark orange text, a light strip across a dark app.
 * The fallbacks are the browser's own colours for the document's side.
 */
export const STORAGE_ALERT_STYLE = [
  'padding:12px',
  'margin:0',
  'background:color-mix(in srgb, var(--color-warning-500, orange) 16%, var(--color-surface, Canvas))',
  'color:var(--color-text, CanvasText)',
  'border-left:4px solid var(--color-warning-500, orange)',
  'font:14px system-ui',
].join(';');

import type { AcknowledgedStoragePersistence, StoragePersistenceStatus, StorageWriteReceipt, StorageWriteState } from '../../../packages/@softn/core/src/runtime/xdb-types';
import type { BackendCallLifecycle } from './backendQueue';

export const STORAGE_PROTOCOL = 1;
export const STORAGE_LIMITS = Object.freeze({ key: 256, value: 30000, entries: 200, map: 256 * 1024, input: 32768, outstanding: 32, queued: 256 * 1024, deadline: 20000 });
export type StorageLimits = { -readonly [K in keyof typeof STORAGE_LIMITS]: number };
/**
 * The most a parent may raise the limits it can name to, in UTF-16 units as the rest are. A
 * parent that keeps an app's store somewhere larger than WebStorage (FormLogic's IndexedDB)
 * says how much it takes in `init.storageLimits`; one that names none, which is every parent
 * before it, keeps STORAGE_LIMITS. A game's saved state runs to hundreds of kilobytes a slot.
 */
export const STORAGE_MAXIMA = Object.freeze({ value: 8 * 1024 * 1024, entries: 2000, map: 64 * 1024 * 1024, input: 8 * 1024 * 1024 + 4096, queued: 64 * 1024 * 1024 });
const NEGOTIATED = ['value', 'entries', 'map', 'input', 'queued'] as const;

/**
 * The limits this frame holds an app's store to: STORAGE_LIMITS, each of the five a parent may
 * name raised to what it names, up to STORAGE_MAXIMA. Never lowered, and anything that is not a
 * whole number above the default is ignored, so a malformed offer is the old limits.
 */
export function storageLimits(offered: unknown): StorageLimits {
  const limits: StorageLimits = { ...STORAGE_LIMITS };
  if (!offered || typeof offered !== 'object' || Array.isArray(offered)) return limits;
  for (const name of NEGOTIATED) {
    let value: unknown;
    try { value = Object.getOwnPropertyDescriptor(offered, name)?.value; } catch { continue; }
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > limits[name]) limits[name] = Math.min(value, STORAGE_MAXIMA[name]);
  }
  return limits;
}

/** What one entry adds to `JSON.stringify` of the whole store: its key and value as JSON, and the colon. */
const entryCost = (key: string, value: string) => JSON.stringify(key).length + 1 + JSON.stringify(value).length;
/** `JSON.stringify` of a store's length, from its entries' costs: the braces, the entries and the commas between them. */
const storeLength = (count: number, costs: number) => 2 + costs + Math.max(0, count - 1);
let mountSequence = 0;

interface Operation {
  input: Record<string, unknown>;
  units: number;
  receipt: StorageWriteReceipt;
  state: StorageWriteState;
  resolve: () => void;
  reject: (reason: Error) => void;
  controller: AbortController;
  /** Later saves of this key that this one now carries; their receipts end with it. */
  joined: { resolve: () => void; reject: (reason: Error) => void }[];
  /** Protocol 1's admission deadline; protocol 0 has none. */
  timer?: ReturnType<typeof setTimeout>;
  deadlineAt: number;
  dispatched: boolean;
}

/**
 * WebStorage remains synchronous. Only the optional protocol-1 receipts confirm a parent save.
 * A parent that does not negotiate protocol 1 (protocol 0) keeps the storage it always had:
 * writes go to it one at a time as ordinary calls, a reply without `error` is a save, a reply
 * with one shows the failed-save alert, and nothing is refused, held back or expired on the
 * way, nor does closing the page ask first.
 */
export function installAppStorage(
  snapshot: Record<string, string>,
  persist: (input: Record<string, unknown>, lifecycle?: BackendCallLifecycle) => Promise<unknown>,
  options: { acknowledged?: boolean; deadlineMs?: number; limits?: StorageLimits } = {},
) {
  const protocol = options.acknowledged === true ? 1 : 0;
  const limits: StorageLimits = options.limits ?? { ...STORAGE_LIMITS };
  const generation = `host-storage-${++mountSequence}`;
  const entries = new Map(Object.entries(snapshot));
  const confirmed = new Map(entries);
  // Each entry's share of the store's JSON length, kept as the store changes: the whole store,
  // which may now be tens of megabytes, was serialised again on every save to be measured.
  const costs = new Map<string, number>();
  let costTotal = 0;
  for (const [key, value] of entries) { const cost = entryCost(key, value); costs.set(key, cost); costTotal += cost; }
  /** The store's size after `input`: its entry count and their costs, and each touched key's new cost (null: gone). */
  const measure = (input: Record<string, unknown>) => {
    if (input.operation === 'clear') return { count: 0, total: 0, touched: null as Map<string, number | null> | null };
    const touched = new Map<string, number | null>();
    let count = entries.size, total = costTotal;
    const was = (key: string) => (touched.has(key) ? touched.get(key)! : costs.get(key) ?? null);
    const put = (key: string, cost: number | null) => {
      const before = was(key);
      if (before !== null) { total -= before; count--; }
      if (cost !== null) { total += cost; count++; }
      touched.set(key, cost);
    };
    if (input.operation === 'remove') put(input.key as string, null);
    else if (input.operation === 'set') put(input.key as string, entryCost(input.key as string, input.value as string));
    else for (const item of input.replacements as { key: string; value: string }[]) put(item.key, entryCost(item.key, item.value));
    return { count, total, touched };
  };
  const commitCosts = (measured: ReturnType<typeof measure>) => {
    if (!measured.touched) costs.clear();
    else for (const [key, cost] of measured.touched) { if (cost === null) costs.delete(key); else costs.set(key, cost); }
    costTotal = measured.total;
  };
  const listeners = new Set<(status: StoragePersistenceStatus) => void>();
  const waiting: Operation[] = [];
  let active: Operation | undefined;
  let unknown: Operation | undefined;
  let terminalUnknownWrites = 0;
  let sequence = 0;
  let units = 0;
  let failedWrites = 0;
  let disposed = false;
  const status = (): StoragePersistenceStatus => ({ protocol, pendingWrites: waiting.length + (active ? 1 : 0), failedWrites, unknownWrites: terminalUnknownWrites + (unknown ? 1 : 0), disposed });
  const notify = () => {
    const current = status();
    for (const listener of listeners) { try { listener(current); } catch { /* Observers cannot strand admitted work. */ } }
    // The warning describes state, never storage contents or backend errors.
    let message = document.getElementById('app-storage-error');
    // Protocol 0 says nothing while it saves, as it never did: only a failure shows.
    if (!current.failedWrites && !current.unknownWrites && (protocol === 0 || !current.pendingWrites)) { message?.remove(); return; }
    if (!message) {
      message = document.createElement('p'); message.id = 'app-storage-error';
      message.setAttribute('role', 'status'); message.style.cssText = STORAGE_ALERT_STYLE;
      document.body.prepend(message);
    }
    message.textContent = current.unknownWrites ? 'An app save has an unknown outcome. Keep this page open; a fresh opening is needed to recover the saved state.'
      : current.failedWrites ? 'An app save failed. Keep this page open and check browser storage before reloading.'
      : 'Saving app data. Keep this page open until saving completes.';
  };
  const failure = (state: 'failed' | 'unknown', reason: string) => Object.assign(new Error(reason), { state });
  const apply = (map: Map<string, string>, input: Record<string, unknown>) => {
    if (input.operation === 'clear') map.clear();
    else if (input.operation === 'remove') map.delete(input.key as string);
    else if (input.operation === 'set') map.set(input.key as string, input.value as string);
    else for (const replacement of input.replacements as { key: string; value: string }[]) map.set(replacement.key, replacement.value);
  };
  const saved = (reply: unknown) => {
    if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return false;
    // Port replies are cloned data. Inherited fields, arrays and accessors
    // cannot turn a malformed reply into a persistence acknowledgment.
    try {
      if ('error' in reply) return false;
      const result = Object.getOwnPropertyDescriptor(reply, 'result')?.value;
      if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
      return Object.getOwnPropertyDescriptor(result, 'saved')?.value === true;
    } catch { return false; }
  };
  // Protocol 0's rule, as it always was: any reply without an error is a save.
  const answered = (reply: unknown) => protocol === 1 ? saved(reply) : !(reply as { error?: unknown } | null | undefined)?.error;
  const release = (operation: Operation) => {
    clearTimeout(operation.timer); units -= operation.units;
    // A caller may retain the receipt/state getter indefinitely. Keep its
    // identity and state, without keeping a settled mutation's full payload.
    // Unknown sent writes reach release only after a late reply or disposal.
    operation.input = {};
  };
  const refuse = (operation: Operation, reason: Error) => {
    operation.reject(reason);
    for (const receipt of operation.joined) receipt.reject(reason);
  };
  const finish = (operation: Operation, reply?: unknown, timedOut = false) => {
    if (operation.state !== 'pending') return;
    clearTimeout(operation.timer);
    if (active === operation) active = undefined;
    else { const index = waiting.indexOf(operation); if (index >= 0) waiting.splice(index, 1); }
    const outcome = reply && typeof reply === 'object' ? (reply as { outcome?: string }).outcome : undefined;
    if (!timedOut && answered(reply)) {
      operation.state = 'confirmed'; apply(confirmed, operation.input); release(operation); operation.resolve();
      for (const receipt of operation.joined) receipt.resolve();
    } else if ((timedOut || outcome === 'unknown') && operation.dispatched && outcome !== 'unsent') {
      operation.state = 'unknown'; unknown = operation;
      refuse(operation, failure('unknown', 'The app save outcome is unknown.'));
    } else {
      operation.state = 'failed'; failedWrites++; release(operation);
      refuse(operation, failure('failed', protocol === 0 ? 'The app save failed.' : 'The app save was not confirmed.'));
    }
    notify(); pump();
  };
  const late = (operation: Operation, reply: unknown) => {
    if (disposed || unknown !== operation) return;
    unknown = undefined;
    if (saved(reply) && protocol === 1) { operation.state = 'confirmed'; apply(confirmed, operation.input); }
    else { operation.state = 'failed'; failedWrites++; }
    release(operation); notify(); pump();
  };
  function pump(): void {
    if (disposed || active || unknown || !waiting.length) return;
    const operation = waiting.shift()!;
    active = operation;
    if (protocol === 1 && operation.deadlineAt <= Date.now()) { finish(operation, undefined, true); return; }
    try {
      // The queue may hold this behind ordinary native calls. Its deadline
      // remains the admission deadline, and cancellation removes unsent work.
      // Protocol 0's write is an ordinary call, with an ordinary call's timing.
      const call = protocol === 0 ? persist(operation.input) : persist(operation.input, {
        deadlineAt: operation.deadlineAt, signal: operation.controller.signal,
        onDispatch: () => { operation.dispatched = true; },
        onReply: reply => finish(operation, reply),
        onLateReply: reply => late(operation, reply),
      });
      Promise.resolve(call).then(reply => finish(operation, reply), () => finish(operation, { outcome: operation.dispatched ? 'unknown' : 'unsent' }, true));
    } catch { finish(operation, { outcome: 'unsent' }); }
  }
  const quota = () => new DOMException('App storage limit reached', 'QuotaExceededError');
  /**
   * The save just before this one, when this one makes it pointless. A set holds the key's whole
   * value, and XDB keeps a collection under one key, so a loop adding records wrote the whole
   * collection again each time: the 33rd was refused as a full store with room to spare. Only the
   * last in the queue: taking an earlier one would send a key's newer value ahead of a write to
   * another key that came first, and an index could land before the record it names. One value
   * goes for all of them, so a refusal of the newest is a refusal of those it replaced.
   */
  const unsentSetOf = (input: Record<string, unknown>) => {
    if (protocol !== 1 || input.operation !== 'set') return undefined;
    const last = waiting.at(-1);
    return last?.input.operation === 'set' && last.input.key === input.key ? last : undefined;
  };
  const expireAtDeadline = (operation: Operation) => {
    clearTimeout(operation.timer);
    operation.timer = setTimeout(() => { operation.controller.abort(); finish(operation, undefined, true); }, Math.max(0, operation.deadlineAt - Date.now()));
  };
  function admit(input: Record<string, unknown>): StorageWriteReceipt {
    if (disposed) throw new DOMException('App storage is disposed', 'InvalidStateError');
    if (unknown) throw new DOMException('An earlier app save has an unknown outcome', 'InvalidStateError');
    // Freeze the exact bounded wire input once. No caller can change a queued
    // batch after admission, and accounting uses the parent's UTF-16 units.
    const serialized = JSON.stringify(input);
    if (protocol === 1 && serialized.length > limits.input) throw quota();
    const frozen = JSON.parse(serialized) as Record<string, unknown>;
    if (Array.isArray(frozen.replacements)) { for (const item of frozen.replacements) Object.freeze(item); Object.freeze(frozen.replacements); }
    Object.freeze(frozen);
    const measured = measure(frozen);
    // Protocol 0 holds a set to the cache's limits, and nothing else, as it always did.
    if ((protocol === 1 || frozen.operation === 'set') && (measured.count > limits.entries || storeLength(measured.count, measured.total) > limits.map)) throw quota();
    const earlier = unsentSetOf(frozen);
    if (protocol === 1 && ((!earlier && waiting.length + (active ? 1 : 0) >= STORAGE_LIMITS.outstanding) || units - (earlier?.units ?? 0) + serialized.length > limits.queued)) throw quota();
    apply(entries, frozen); commitCosts(measured);
    let resolve!: () => void; let reject!: (reason: Error) => void;
    const completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // Sync WebStorage callers may ignore receipts; failures stay observable
    // without an unhandled rejection. This does not change the returned promise.
    void completion.catch(() => {});
    const deadlineAt = Date.now() + (options.deadlineMs ?? STORAGE_LIMITS.deadline);
    if (earlier) {
      // It keeps its place and takes the newest value, with that value's deadline: it had the time
      // of the oldest, and died with it. Both receipts say what became of it.
      units += serialized.length - earlier.units;
      earlier.units = serialized.length; earlier.input = frozen; earlier.joined.push({ resolve, reject });
      earlier.deadlineAt = deadlineAt; expireAtDeadline(earlier);
      notify();
      return Object.freeze({ generation, sequence: ++sequence, completion, get state() { return earlier.state; } });
    }
    const operation = { input: frozen, units: serialized.length, state: 'pending' as StorageWriteState, resolve, reject, controller: new AbortController(), joined: [] as Operation['joined'], deadlineAt, dispatched: false } as Operation;
    operation.receipt = Object.freeze({ generation, sequence: ++sequence, completion, get state() { return operation.state; } });
    if (protocol === 1) expireAtDeadline(operation);
    units += operation.units; waiting.push(operation);
    notify(); pump(); return operation.receipt;
  }
  const setItem = (key: string, value: string) => {
    key = String(key); value = String(value);
    if (key.length > limits.key || value.length > limits.value) throw quota();
    return admit({ operation: 'set', key, value });
  };
  const removeItem = (key: string) => { key = String(key); if (protocol === 1 && key.length > limits.key) throw quota(); return admit({ operation: 'remove', key }); };
  const whenIdle = () => Promise.allSettled([...waiting, ...(active ? [active] : [])].map(item => item.receipt.completion)).then(() => {});
  const common = { getStatus: status, subscribe(listener: (status: StoragePersistenceStatus) => void) { listeners.add(listener); return () => listeners.delete(listener); }, whenIdle };
  const acknowledgedPersistence: AcknowledgedStoragePersistence = protocol === 0 ? { protocol: 0, ...common } : {
    // The frame has no permissions and resumes no sync room, so only this page reads this store.
    protocol: 1, localOnly: true, ...common, setItem, removeItem,
    replaceBatch(replacements) {
      if (!Array.isArray(replacements) || !replacements.length || replacements.length > limits.entries) throw quota();
      const keys = new Set<string>();
      for (const item of replacements) {
        if (!item || typeof item.key !== 'string' || typeof item.value !== 'string' || item.key.length > limits.key || item.value.length > limits.value || keys.has(item.key)) throw quota();
        keys.add(item.key);
      }
      return admit({ operation: 'batch', replacements });
    },
    captureBarrier() {
      if (disposed || failedWrites || unknown) return Promise.reject(failure(unknown ? 'unknown' : 'failed', 'An app save was not confirmed.'));
      return Promise.all([...waiting, ...(active ? [active] : [])].map(item => item.receipt.completion)).then(() => {});
    },
  };
  const storage: Storage = {
    get length() { return entries.size; }, key: index => Array.from(entries.keys())[index] ?? null,
    getItem: key => entries.get(String(key)) ?? null,
    setItem(key, value) { setItem(key, value); }, removeItem(key) { removeItem(key); }, clear() { admit({ operation: 'clear' }); },
  };
  Object.defineProperty(storage, 'acknowledgedPersistence', { value: acknowledgedPersistence });
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: false });
  const unloadGuard = (event: BeforeUnloadEvent) => { const value = status(); if (protocol === 1 && (value.pendingWrites || value.failedWrites || value.unknownWrites)) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', unloadGuard);
  return {
    storage, acknowledgedPersistence, confirmedSnapshot: () => Object.fromEntries(confirmed),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const item of [...waiting, ...(active ? [active] : [])]) { finish(item, { outcome: item.dispatched ? 'unknown' : 'unsent' }, true); item.controller.abort(); }
      if (unknown) { terminalUnknownWrites = 1; release(unknown); unknown = undefined; }
      active = undefined; waiting.length = 0;
      window.removeEventListener('beforeunload', unloadGuard);
      notify(); listeners.clear();
    },
  };
}
