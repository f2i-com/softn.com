/**
 * The page's window, as a script's `window` meets it: the listeners the
 * script puts on its window, heard from the real one, and the `window.__…`
 * values the two share (a game's input latches, a camera's yaw), copied each
 * way around a call into the script.
 */

import { EventCoalescer, coalescePolicyFor } from './event-coalescer';
import { extractEventProps } from './event-props';
import { appHears, shouldCaptureKey } from './key-capture';
import type { LogicEngine } from './vm-adapter';

/** `window.__…` names a script's window never writes to the page's (see fromVM). */
const HOST_WINDOW_NAME = /^__(?:tauri|react|softn|vite|webpack|playwright|vue|next|nuxt|zone|proto__$)/i;

/**
 * Which app's script wrote each `window.__…` value onto the page's window,
 * and which of its runtimes did. The page has one window, and SoftN Web
 * keeps every open app mounted: a value one app's script wrote was read by
 * every other app whose script named it, and written over by it. So an app
 * with no `net` could hand its records to an open app with `net`, or press
 * another app's input latches. The first app whose script writes a key owns
 * it until the last of its runtimes that wrote it closes; meanwhile no other
 * app's script reads it or writes it. Two views of one app are one owner. A
 * key no script has written, as a component sets one (Scene3D's
 * `__scene3dLocked`), is every app's as before; and a claim lapses once the
 * window holds a value its app did not write there (`value`): a component's
 * key that one app's script wrote first kept every other app from reading
 * what the component then set.
 */
const windowKeyOwners = new Map<string, { app: string | null; writers: Set<WindowBridge>; value: unknown }>();

/**
 * Run the script's listeners for an event the page's window heard.
 * `throttled` is a high-frequency event, delivered at most once a frame.
 */
export type WindowEventDispatch = (eventType: string, eventObj: Record<string, unknown>, throttled: boolean) => void;

export class WindowBridge {
  /**
   * Active native event listeners for the window bridge.
   * Managed at the JS level since the WASM VM stores handler Values internally.
   */
  private nativeListeners: Map<string, EventListener[]> = new Map();
  /** Per-frame delivery for the high-frequency events; disposed with the listeners. */
  private eventCoalescers: EventCoalescer[] = [];

  /** Index of the `window` global in the VM; -1 until a script that declares one is loaded. */
  windowGlobalIndex = -1;

  /** Set of __ window property keys to sync */
  private syncKeys: Set<string> = new Set();
  /** Cached: true when at least one syncKey is defined on the real window */
  private windowSyncActive = false;
  /**
   * The `__` globals the host page already had when this runtime was made —
   * `__TAURI__`, `__softnAsset`, a devtools hook. A script may read them, and
   * a script that sets `window.__TAURI__` in the VM is welcome to its own
   * copy, but none of them is written back to the real window: that is the
   * host's bridge to native, and a bundle replacing it is a bundle taking the
   * host over. Everything the app introduces itself still syncs both ways,
   * which is what the games' input latches (`__scene3dLocked`, `__dhFire`)
   * rely on — Scene3D and the demo driver set those on the real window after
   * the script has declared them.
   */
  private readonly hostWindowKeys: Set<string>;
  /**
   * Keys this runtime wrote onto the real window. Removed again at cleanup,
   * so that a reload of the same app does not find its own latches already
   * there and mistake them for the host's.
   */
  private windowKeysWritten = new Set<string>();

  /** Event types already bridged from VM → browser (prevents duplicate listeners) */
  private bridgedEventTypes: Set<string> = new Set();

  /** What each synced window global held when it was last handed to the VM. */
  private windowSyncSeen = new Map<string, unknown>();

  /**
   * @param owner The runtime whose app this is: what key-capture.ts keeps the
   *   app's element and captured keys under.
   * @param engine The engine running the script, while there is one.
   * @param dispatch Runs an event the window heard into the script.
   * @param app The app's identity, which owns the keys its script writes
   *   (windowKeyOwners); null for a host that gives none, whose runtimes are
   *   one app as far as the window goes.
   */
  constructor(
    private readonly owner: object,
    private readonly engine: () => LogicEngine | null,
    private readonly dispatch: WindowEventDispatch,
    private readonly app: string | null = null
  ) {
    // Taken before the app's document mounts, so what is here is the host's,
    // but for what an app's script put there (windowKeyOwners): a second
    // view of an app took its own latches for the host's, and never wrote
    // them, and so did any app for a key another had written.
    this.hostWindowKeys = new Set(
      typeof window === 'undefined'
        ? []
        : Object.getOwnPropertyNames(window).filter((k) => k.startsWith('__') && !windowKeyOwners.has(k))
    );
  }

  /** Whether another app's script owns `key` (windowKeyOwners), as long as what it wrote is what the window holds. */
  private ownedElsewhere(key: string): boolean {
    const owner = windowKeyOwners.get(key);
    if (owner === undefined || owner.app === this.app) return false;
    if (typeof window !== 'undefined' && !Object.is((window as unknown as Record<string, unknown>)[key], owner.value)) {
      // Set since by something else, a component or the host: no app's now.
      windowKeyOwners.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Discover and bridge VM event listeners to real browser event listeners.
   * Called after every async VM function call so listeners registered in _init()
   * or any other function are automatically bridged.
   *
   * The mapping is fully dynamic — the runtime does not hardcode any key bindings.
   * The .logic code registers handlers (e.g. window.addEventListener("keydown", fn)),
   * and this method bridges those to real browser events.
   */
  listen(): void {
    const engine = this.engine();
    if (!engine || typeof window === 'undefined') return;

    const types = engine.getEventListenerTypes();
    for (const eventType of types) {
      if (this.bridgedEventTypes.has(eventType)) continue;
      this.bridgedEventTypes.add(eventType);

      // Pointer movement, scrolling, resizing and the wheel arrive several
      // times a frame; they cross the bridge at most once a frame, combined
      // by a policy the event type chooses — see event-coalescer.ts. Ordering
      // is preserved: nothing is delivered ahead of a sample already waiting.
      const policy = coalescePolicyFor(eventType);
      const isThrottled = policy !== null;
      const dispatch = (eventObj: Record<string, unknown>) => this.dispatch(eventType, eventObj, isThrottled);

      let listener: (event: Event) => void;
      if (policy !== null) {
        const coalescer = new EventCoalescer(policy, dispatch);
        this.eventCoalescers.push(coalescer);
        listener = (event: Event) => {
          if (!this.engine() || !appHears(this.owner, event)) return;
          coalescer.push(extractEventProps(event));
        };
      } else {
        listener = (event: Event) => {
          // Only what is aimed at this app: see key-capture.ts.
          if (!this.engine() || !appHears(this.owner, event)) return;
          // A key the script asked to keep whole: the browser's default is
          // cancelled here, since the handler runs too late to do it.
          if (shouldCaptureKey(event, this.owner)) event.preventDefault();
          dispatch(extractEventProps(event));
        };
      }

      window.addEventListener(eventType, listener);
      if (!this.nativeListeners.has(eventType)) {
        this.nativeListeners.set(eventType, []);
      }
      this.nativeListeners.get(eventType)!.push(listener);
    }
  }

  /**
   * Discover __ prefixed properties on the VM's window object and register
   * them as sync keys. This makes window property sync fully dynamic — the
   * .logic code sets any window.__xxx property and it gets synced automatically.
   */
  discoverSyncKeys(): void {
    const engine = this.engine();
    if (this.windowGlobalIndex < 0 || !engine) return;

    const vmWindow = engine.getGlobal(this.windowGlobalIndex);
    if (!vmWindow || typeof vmWindow !== 'object') return;

    for (const key of Object.keys(vmWindow as Record<string, unknown>)) {
      if (key.startsWith('__') && !this.syncKeys.has(key)) {
        this.syncKeys.add(key);
        this.windowSyncActive = true;
      }
    }
  }

  /**
   * Register a __ window property key for syncing from real window → VM.
   */
  registerSyncKey(key: string): void {
    if (key.startsWith('__')) {
      this.syncKeys.add(key);
    }
  }

  /**
   * Sync properties from the real browser `window` into the VM's `window` global.
   * Only syncs __ prefixed keys registered via registerSyncKey().
   * Short-circuits when no sync keys have values on the real window.
   */
  toVM(): void {
    const engine = this.engine();
    if (this.windowGlobalIndex < 0 || !engine) return;
    if (typeof window === 'undefined' || this.syncKeys.size === 0) return;

    // Quick check: are any syncKeys actually set on the real window?
    const realWin = window as unknown as Record<string, unknown>;
    if (!this.windowSyncActive) {
      // Periodically recheck (cheap: just test 2 keys)
      for (const key of this.syncKeys) {
        if (realWin[key] !== undefined) {
          this.windowSyncActive = true;
          break;
        }
      }
      if (!this.windowSyncActive) return;
    }

    const vmWindow = engine.getGlobal(this.windowGlobalIndex);
    if (!vmWindow || typeof vmWindow !== 'object') return;

    const updated: Record<string, unknown> = { ...(vmWindow as Record<string, unknown>) };
    let changed = false;

    for (const key of this.syncKeys) {
      if (this.ownedElsewhere(key)) continue;
      const value = realWin[key];
      if (value !== undefined && typeof value !== 'function') {
        updated[key] = value;
        // Remembered so the write-back can tell a value the script changed
        // from one it merely received.
        this.windowSyncSeen.set(key, value);
        changed = true;
      }
    }

    if (changed) {
      engine.setGlobal(this.windowGlobalIndex, updated);
    }
  }

  /**
   * Sync properties from the VM's `window` global back to the real browser `window`.
   * Only syncs keys registered via registerSyncKey().
   */
  fromVM(): void {
    if (!this.windowSyncActive) return;
    const engine = this.engine();
    if (this.windowGlobalIndex < 0 || !engine) return;
    if (typeof window === 'undefined' || this.syncKeys.size === 0) return;

    const vmWindow = engine.getGlobal(this.windowGlobalIndex);
    if (!vmWindow || typeof vmWindow !== 'object') return;

    const realWin = window as unknown as Record<string, unknown>;
    const vmWinObj = vmWindow as Record<string, unknown>;

    for (const key of this.syncKeys) {
      const value = vmWinObj[key];
      if (value === undefined) continue;
      // The host's own globals are read-only from in here — see hostWindowKeys.
      // A function is the host's as well whatever its name: the VM never
      // receives one (toVM skips them), so it cannot be handing one back,
      // only replacing it.
      if (this.hostWindowKeys.has(key) || typeof realWin[key] === 'function') continue;
      // Nor names the host, its frameworks or SoftN itself may give a value
      // later: `__TAURI__` written from here made every app opened after it
      // take the page for the desktop runtime, and fail to open its storage.
      if (HOST_WINDOW_NAME.test(key)) continue;
      // A value the script did not touch is not written back. The browser
      // may have moved it since the call began — a pointer-locked camera
      // writes __scene3dYaw on every mouse move — and echoing the copy the
      // VM was handed would throw that movement away.
      if (this.windowSyncSeen.has(key) && Object.is(this.windowSyncSeen.get(key), value)) continue;
      // Another app's: see windowKeyOwners.
      if (this.ownedElsewhere(key)) continue;
      realWin[key] = value;
      let owner = windowKeyOwners.get(key);
      if (!owner) windowKeyOwners.set(key, (owner = { app: this.app, writers: new Set(), value }));
      owner.writers.add(this);
      owner.value = value;
      this.windowKeysWritten.add(key);
      this.windowSyncSeen.set(key, value);
    }
  }

  /** Stop listening, and take the app's own `__` values off the page's window. */
  dispose(): void {
    if (typeof window !== 'undefined') {
      for (const [eventName, listeners] of this.nativeListeners.entries()) {
        for (const listener of listeners) {
          window.removeEventListener(eventName, listener);
        }
      }
    }
    this.nativeListeners.clear();
    this.bridgedEventTypes.clear();
    // A frame already requested must not fire into a disposed engine.
    for (const coalescer of this.eventCoalescers) coalescer.dispose();
    this.eventCoalescers = [];
    this.syncKeys.clear();
    this.windowSyncSeen.clear();
    this.windowSyncActive = false;
    // The app's latches go with the app. Left behind, the next runtime on
    // this page — a reload of the same bundle — would snapshot them as the
    // host's and refuse to write them, and pointer lock would never engage.
    // Another view of the app still writing a key keeps it, and its value.
    const released: string[] = [];
    for (const key of this.windowKeysWritten) {
      const owner = windowKeyOwners.get(key);
      // A claim that lapsed, or that another app has made since: what the
      // window holds is not this app's to take away.
      if (!owner || !owner.writers.has(this)) continue;
      owner.writers.delete(this);
      if (owner.writers.size > 0) continue;
      windowKeyOwners.delete(key);
      released.push(key);
    }
    if (typeof window !== 'undefined') {
      const realWin = window as unknown as Record<string, unknown>;
      for (const key of released) {
        if (this.hostWindowKeys.has(key)) continue;
        try {
          delete realWin[key];
        } catch {
          // A non-configurable property is not this runtime's to remove.
        }
      }
    }
    this.windowKeysWritten.clear();
  }
}
