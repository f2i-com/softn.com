/**
 * The script runtime's types: what a host hands it (the context, the
 * options, `permission.json`) and what it hands back. script-runtime.ts
 * exports them all, as it always has; the modules it is made of import them
 * from here.
 */

import type { ScriptBlock, LogicBlock } from '../parser/ast';
import type { RuntimeState, XDBRecord } from '../types';
import type { DocumentShell } from '../document-shell/host';
import type { PythonProject } from './vm-adapter';
import type { AIPermissionConfig, GpuPermissionConfig } from './ai-manager';

/**
 * Type alias for code blocks - either ScriptBlock or LogicBlock
 */
export type CodeBlock = ScriptBlock | LogicBlock;

/**
 * Execution context handed to SoftN scripts.
 */
export interface ScriptContext {
  // State management
  state: RuntimeState;
  setState: (path: string, value: unknown) => void;
  /** Batch multiple state changes into a single React setState call (optional optimization) */
  batchSetState?: (changes: Record<string, unknown>) => void;
  /**
   * Draw the page again, though no state it holds has changed: state that
   * only a function the page calls while it is drawn reads has moved in the
   * engine. Optional; a host without it has such state copied to the page
   * instead, which is slower and has the same effect.
   */
  redraw?: () => void;

  // XDB data
  data: Record<string, XDBRecord[]>;

  // XDB operations
  xdb: XDBModule;

  // Navigation
  nav: NavModule;

  // Console (for debugging)
  console: ConsoleModule;
}

/**
 * XDB module for SoftN scripts
 */
export interface XDBModule {
  create: (collection: string, data: Record<string, unknown>) => Promise<XDBRecord>;
  update: (id: string, data: Record<string, unknown>) => Promise<XDBRecord>;
  delete: (id: string) => Promise<void>;
  query: (collection: string, filter?: Record<string, unknown>) => Promise<XDBRecord[]>;
  get: (collection: string, id: string) => Promise<XDBRecord | null>;
  sync: () => Promise<void>;
}

/**
 * Navigation module for SoftN scripts
 */
export interface NavModule {
  goto: (page: string) => void;
  back: () => void;
  params: Record<string, string>;
}

/**
 * Console module for SoftN scripts
 */
export interface ConsoleModule {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export type ScriptRuntimeMode = 'main' | 'worker';

/**
 * How a runtime gets the document a page's code is given: made, and its
 * code loaded, only when the code turns out to use one. Most pages never do.
 */
export interface DocumentShellRequest {
  create(): Promise<DocumentShell>;
}

export interface ScriptRuntimeOptions {
  mode?: ScriptRuntimeMode;
  /**
   * The document the page's code is given when it uses one (`document.…`):
   * its plain HTML as a tree the code can find, change and listen to, as in
   * a browser (document-shell/). Taken only by JavaScript on the main
   * thread; Python, and a script in a worker, are not given it.
   */
  documentShell?: DocumentShellRequest;
  /**
   * The page's markup has handlers written for a browser that SoftN does not
   * read (see `hasPageHandlers`): the page is given its document for them,
   * whatever its code says.
   */
  browserHandlers?: boolean;
  /**
   * Where the app's own files are, as its markup's `src="images/x.png"`
   * finds them: what a page's `fetch('data.json')` reads (`bundle.read`).
   */
  assetResolver?: (path: string) => string;
  /**
   * Logic files the host already concatenated into `script.code` itself.
   *
   * A host that assembles a bundle may inline manifest-listed `.logic` files
   * ahead of the entry file. Those files are then already part of this
   * compilation, so an `import` naming one must not inline it a second time —
   * every class and variable in it would be declared twice, which the VM
   * rejects. Paths are bundle-relative, matching what `importResolver` takes.
   */
  preIncludedLogicPaths?: readonly string[];
  /**
   * The bundle's parsed `permission.json`.
   *
   * Without it every capability check runs in "no config" mode, which is
   * permissive for most APIs but still refuses plain `http://` — so a bundle
   * that legitimately declares `net.allow_http` cannot reach its own server.
   */
  permissionConfig?: PermissionConfig;
  /**
   * Every identifier the document could resolve against React state.
   *
   * State variables outside this set are owned by the VM: the host neither
   * reads them back nor writes them, because nothing outside the VM can
   * observe them. See `partitionStateVars` in script-runtime.ts.
   *
   * Omit it and every state variable is synced, which is what every host did
   * before this existed and is always correct — just slower.
   */
  observedStateNames?: ReadonlySet<string>;
  /**
   * Every name the document could call while it is drawn, from
   * `collectDrawnNames`: the names its expressions are written with, without
   * what only an event runs.
   *
   * A function among them is how a page reads state its markup does not
   * name, so what that function may read is observed as well. Only looked at
   * beside {@link observedStateNames}. Omit it and every observed name is
   * supposed to be drawn, which is correct and holds less back: a game's
   * `@tick={tick}` then counts, and `tick` reads everything.
   */
  drawnNames?: ReadonlySet<string>;
  /**
   * Where `softn.storage.*` sends its operations: the storage endpoint of
   * the app in the directory that published it. Absent for an app opened
   * from a file, which then has no server storage and is told so.
   */
  storageEndpoint?: string;
  /** Host-owned action bridge. No URLs or credentials are exposed to app scripts. */
  backendCall?: (action: string, input: Record<string, unknown>) => Promise<unknown>;
  /**
   * Where `softn.net.fetch` goes instead of the browser's `fetch`.
   *
   * Some hosts do not give an app the network at all: they route what it asks
   * for through something of their own — a backend that owns the credentials,
   * a proxy that owns the allowlist — and the app never holds a URL the
   * browser would act on. Those hosts used to do this by rewriting
   * `softn.net.fetch` inside the guest, which works only while the guest is
   * JavaScript and only while the host is willing to edit the author's source.
   * This is the same substitution made on the host's side of the VM, so it
   * does not depend on either.
   *
   * Setting it MOVES the capability, checks included. `permission.json`'s
   * `net` block and `allowed_hosts` describe what the app may reach with the
   * browser's `fetch`, and there is no browser `fetch` here; the handler's
   * owner decides what the call is allowed to become. That is the same
   * arrangement as `backendCall`, which has never been permission-checked
   * either, because the host names the actions it will answer.
   *
   * Absent — every host that has one today — `softn.net.fetch` is exactly what
   * it was: the permission check, the host allowlist, and the browser's fetch.
   */
  netFetchHandler?: NetFetchHandler;
  /**
   * The app's logic, when it is written in Python rather than JavaScript.
   *
   * `composeBundleSource` sets it from the bundle's own file names: a logic
   * file ending `.py` is Python. When it is present the script's `<logic>`
   * block is empty by construction and these modules are what the engine
   * compiles — there is no JavaScript to assemble, and an engine that cannot
   * run Python is refused before any of the author's code is touched.
   */
  pythonProject?: PythonProject;
  /**
   * The visitor identity sent with storage requests, for collections whose
   * policy records who added a record. Absent, the runtime uses the token
   * this browser keeps (see visitor-token.ts); null sends none.
   */
  storageVisitorToken?: string | null;
  /**
   * Called when a `localStorage` write the script made was refused by the
   * browser — quota, most often. The script sees the failure too, as an
   * exception from the call; this is for the host to tell the person, who
   * otherwise learns of a lost save when they come back for it.
   */
  onPersistenceFailure?: (failure: PersistenceFailure) => void;
  /**
   * Show what the page's `alert()` says, inside the app. With none, it is
   * written to the console: the browser's own dialog is never used, since
   * it carries the host's name and holds the whole tab.
   */
  onAlert?: (message: string) => void;
}

/**
 * What `softn.net.fetch` answers a script with: the browser response reduced
 * to what crosses into the VM. A handler returns this so a script cannot tell
 * which side of the VM the request was made from.
 */
export interface NetFetchResult {
  ok: boolean;
  status: number;
  statusText?: string;
  body: string;
  headers: Record<string, string>;
}

/**
 * A host's stand-in for the browser's `fetch`, for `softn.net.fetch`.
 *
 * `options` is the object the script passed, already parsed — `method`,
 * `headers`, `body`, `timeout` — and `url` is the URL it wrote, unjudged. See
 * {@link ScriptRuntimeOptions.netFetchHandler} for what supplying one means.
 */
export type NetFetchHandler = (
  url: string,
  options: Record<string, unknown>
) => Promise<NetFetchResult>;

/** A write to the browser's storage that was not kept, as reported to the host. */
export interface PersistenceFailure {
  /** `setItem`, `removeItem` or `clear`. */
  operation: string;
  /** The script's own key, without the app prefix; empty for `clear`. */
  key: string;
  /** The browser's exception, with its own name for the cause. */
  error: Error;
}

export interface ScriptLoadResult {
  state: Record<string, unknown>;
  functions: Record<string, (...args: unknown[]) => Promise<unknown>>;
  syncFunctions: Record<string, (...args: unknown[]) => unknown>;
  computed: Record<string, () => unknown>;
}

export interface ScriptRuntimeHandle {
  loadScript: (script: CodeBlock) => Promise<ScriptLoadResult>;
  updateContext: (newState: Partial<RuntimeState>) => void;
  cleanup: () => void;
  /** The element the app is drawn in: its window listeners hear what is aimed there. */
  setAppRoot?: (element: Element | null) => void;
}

/**
 * Permission config from permission.json — describes what capabilities an app needs.
 */
export interface PermissionConfig {
  app?: { id?: string; name?: string; version?: string };
  permissions: {
    net?: { enabled?: boolean; allowed_hosts?: string[]; allow_http?: boolean };
    camera?: { enabled?: boolean; modes?: string[] };
    mic?: { enabled?: boolean; maxSeconds?: number };
    files?: { enabled?: boolean; scopes?: string[] };
    qr?: { enabled?: boolean };
    ai?: AIPermissionConfig;
    gpu?: GpuPermissionConfig;
    sync?: { enabled?: boolean };
    /**
     * The app's own database on the directory that publishes it, reached
     * through `softn.storage.*`. Unrelated to the manifest's legacy
     * `permissions.storage` flag, which is about localStorage.
     */
    storage?: {
      enabled?: boolean;
      /**
       * A policy per collection name (`*` for the rest): who may read, add,
       * change and remove its records. See STORAGE_POLICIES in capabilities.ts.
       * Fixed at publication; the directory enforces it, not the runtime.
       */
      collections?: Record<string, string>;
    };
    /**
     * Generated numeric code runs on the host's own engine: the script hands
     * over functions it builds at run time (an emulator's compiled traces, a
     * signal kernel), validated against a closed arithmetic language and bound
     * to views of the script's typed arrays. Many times faster than the
     * sandbox's interpreter for that code; nothing else of the host is
     * reachable from it.
     */
    accel?: { enabled?: boolean };
  };
  /**
   * The bundle declared capabilities and the user has not answered yet.
   *
   * Set by the host when it boots an app with its declared capabilities
   * withheld so the UI can be seen before anything is granted. `permissions`
   * is empty in that state, so every check already denies; this only changes
   * what the denial says. Without it the app is told to "add net.enabled to
   * permission.json" — advice for an author, about a file that already says
   * exactly that, aimed at a user who has simply not clicked Allow.
   */
  consentPending?: boolean;
}

/** Pending host call from the VM (mirrors Rust PendingHostCall) */
export interface PendingHostCall {
  id: number;
  kind: string;
  args: string[];
}
