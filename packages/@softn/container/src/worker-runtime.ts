/**
 * Container Sandbox Session Controller.
 *
 * Runs inside a Dedicated Web Worker (`worker-entry.ts`), and can also be
 * instantiated over an in-memory message channel in Node/JSDOM Vitest tests.
 *
 * Responsibilities:
 * - Boots the selected tiered ZIPP WASM engine (`lite` / `javascript` / `typescript` / `python`)
 * - Installs synchronous Worker-local bridges (`localStorage`, `db`, `vfs.fetch`, `esm.resolve`)
 * - Pre-links the ES module graph and handles dynamic `import()` (`esm.load`) on demand
 * - Executes classic `<script>`, `<script type="module">`, TypeScript, and Python entry scripts
 * - Flushes batched `ShellOp[]` DOM & Canvas2D & Split-Realm 3D mutations after every turn
 */

import { shellPrelude } from '../../core/src/document-shell/shell-source';
import { bytesToBase64, mimeTypeFor, resolveVfsPath, VIRTUAL_ORIGIN } from './archive';
import {
  ESM_REGISTRY_PREAMBLE,
  resolveModuleSpecifier,
  transformEsModule,
} from './esm-linker';
import { GUEST_EXTENSIONS_SOURCE } from './guest-canvas-and-ext';
import { GUEST_BROWSER_GLOBALS_SOURCE } from './guest-browser-globals';
import { GUEST_WEB_APIS_SOURCE } from './guest-web-apis';
import { isExternalUrlAllowed } from './sanitize';
import { loadZippEngine, type ZippEngineInstance } from './zipp-loader';
import type {
  ContainerPermissions,
  HostToWorkerMsg,
  ShellOp,
  WorkerToHostMsg,
} from './types';
import type { Capability } from '@softn/bundle-format/capabilities';

/** A socket the Worker holds open for the app, and what has arrived on it that the app has not taken yet. */
interface OpenSocket {
  ws: WebSocket;
  events: Array<Record<string, unknown>>;
  bytes: number;
  /** The app's standing call for the next events, answered when there are some. */
  waiting: number | null;
  /** Closed, or being closed for holding too much: nothing more is taken from it. */
  over: boolean;
}

/** The most sockets one app holds open, and the most that is kept for it unread on one. */
const MAX_SOCKETS = 8;
const MAX_SOCKET_QUEUE_BYTES = 16 * 1024 * 1024;
const MAX_SOCKET_QUEUE_EVENTS = 10_000;
/** The longest message an app sends, in characters as the bridge carries it (text, or base64). */
const MAX_SOCKET_MESSAGE_CHARS = 8 * 1024 * 1024;

function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const DB_SYNC_OPS = [
  'db.query',
  'db.get',
  'db.create',
  'db.update',
  'db.delete',
  'db.hardDelete',
  'db.startSync',
  'db.stopSync',
  'db.getSyncStatus',
  'db.getSavedSyncRoom',
];

/**
 * What `console.warn` writes ahead of its line, between two invisible separators, so that a
 * warning can be told from an error on the one stream the engine gives both. An app that
 * writes it itself only calls its own error a warning.
 */
const WARNING_MARK = '⁣softn:warn⁣';

const LS_SYNC_OPS = ['ls.getItem', 'ls.setItem', 'ls.removeItem', 'ls.clear'];
const APP_SYNC_OPS = ['app.esm.resolve', 'app.vfs.fetch'];

interface DbRecord {
  id: string;
  created_at: string;
  updated_at: string;
  _deleted?: boolean;
  [key: string]: unknown;
}

export class ContainerWorkerSession {
  private readonly postToHost: (msg: WorkerToHostMsg) => void;
  private readonly fallbackGlueFactory?: () => Promise<Record<string, unknown>>;

  private engine: ZippEngineInstance | null = null;
  private textFiles: Record<string, string> = {};
  private binaryFiles: Record<string, Uint8Array> = {};
  private importMap: Record<string, string> = {};
  private vendorModules: Record<string, string> = {};
  private runtimeUrl = '/runtime/';
  private permissions: ContainerPermissions = {};
  private grantedCapabilities = new Set<Capability>();
  private instructionsPerTurn = 100_000_000;
  private storageQuotaBytes = 5 * 1024 * 1024;
  /** What the app's records take of that quota, as last kept (`recordBytes()` then). */
  private recordBytesKept = 0;
  private language: 'javascript' | 'typescript' | 'python' = 'javascript';

  private readonly localStore = new Map<string, string>();
  private localStoreBytes = 0;
  private readonly dbCollections = new Map<string, Map<string, DbRecord>>();
  private dbRecordSeq = 1;

  private readonly definedModules = new Set<string>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  /** The host says the app is not on screen: its timers wait (`heldTimers`: timer id to its callback), and no frame is asked for. */
  private paused = false;
  private readonly sockets = new Map<string, OpenSocket>();
  private readonly heldTimers = new Map<number, number>();
  private disposed = false;

  constructor(
    postToHost: (msg: WorkerToHostMsg) => void,
    fallbackGlueFactory?: () => Promise<Record<string, unknown>>
  ) {
    this.postToHost = postToHost;
    this.fallbackGlueFactory = fallbackGlueFactory;
  }

  async handleMessage(msg: HostToWorkerMsg): Promise<void> {
    if (this.disposed && msg.type !== 'dispose') return;

    switch (msg.type) {
      case 'init':
        await this.handleInit(msg);
        break;
      case 'event':
        this.handleEvent(msg.turnId, msg.nodeId, msg.eventType, msg.props, msg.syncChanges);
        break;
      case 'sync':
        this.handleSync(msg.changes);
        break;
      case 'raf':
        this.handleRaf(msg.timestamp);
        break;
      case 'permissions-updated':
        this.grantedCapabilities = new Set(msg.grantedCapabilities);
        break;
      case 'pause':
        this.paused = true;
        break;
      case 'resume':
        this.resume();
        break;
      case 'dispose':
        this.dispose();
        break;
    }
  }

  private async handleInit(msg: Extract<HostToWorkerMsg, { type: 'init' }>): Promise<void> {
    // No prototype: a file may be called `constructor`, and `in` below asks about the app's files alone.
    this.textFiles = Object.assign(Object.create(null), msg.textFiles);
    this.binaryFiles = Object.assign(Object.create(null), msg.binaryFiles);
    this.importMap = { ...msg.manifest.importMap };
    this.vendorModules = { ...(msg.vendorModules ?? {}) };
    this.runtimeUrl = msg.runtimeUrl || '/runtime/';
    this.permissions = msg.permissions;
    this.grantedCapabilities = new Set(msg.grantedCapabilities);
    this.instructionsPerTurn = msg.limits.instructionsPerTurn;
    this.storageQuotaBytes = msg.limits.storageQuotaBytes;

    // Seed localStorage
    for (const [k, v] of Object.entries(msg.initialStorage)) {
      this.localStore.set(k, v);
      this.localStoreBytes += (k.length + v.length) * 2;
    }

    // Seed DB from `.xdb` files inside the bundle + persisted host DB records
    this.seedDatabase(msg.initialDbRecords);
    // What the page holds of the app's records already, which its localStorage shares a quota with.
    this.recordBytesKept = Object.keys(msg.initialDbRecords).length > 0 ? JSON.stringify(msg.initialDbRecords).length * 2 : 0;

    try {
      const bindings = await loadZippEngine({
        tier: msg.engineTier,
        runtimeUrl: this.runtimeUrl,
        explicitSource: msg.engineModule,
        fallbackGlueFactory: this.fallbackGlueFactory,
      });

      if (this.disposed) return;

      const engine = new bindings.Engine();
      this.engine = engine;
      this.installBridges(engine);

      // Python project execution path
      const pyScripts = msg.scripts.filter((s) => s.language === 'python');
      if (pyScripts.length > 0 && msg.scripts.every((s) => s.language === 'python')) {
        this.language = 'python';
        engine.setSyncHostCapabilities([]);
        engine.setInstructionBudget(this.instructionsPerTurn);
        const pyFiles: Record<string, string> = {};
        for (const [p, content] of Object.entries(this.textFiles)) {
          if (/\.py$/i.test(p)) pyFiles[p] = content;
        }
        const entry = pyScripts[pyScripts.length - 1];
        // A script written in the page has no file of its own, and the name the page gives it
        // (`index.html.inline-1.py`) is not one Python can import: the engine answered "Python
        // project: no modules" and the app never started. It joins the project under a name
        // that is a module's.
        const entryFile = entry.src ? entry.originPath : '__softn_page__.py';
        pyFiles[entryFile] = entry.code;
        if (engine.initPythonProject) {
          engine.initPythonProject(pyFiles, entryFile, []);
        } else {
          engine.initSource(entry.code, 'python');
        }
        this.drainConsole();
        this.postToHost({ type: 'ready' });
        return;
      }

      this.language = msg.engineTier === 'typescript' ? 'typescript' : 'javascript';

      // Pre-register built-in module names so static graph walk skips them
      for (const builtin of [
        'softn:db',
        'softn:storage',
        'softn:net',
        'softn-vendor:marked',
        'softn-vendor:preact',
        'softn-vendor:preact/hooks',
        'softn-vendor:htm',
        'softn-vendor:three',
      ]) {
        this.definedModules.add(builtin);
      }

      // Pre-link all reachable VFS & inline-supplied vendor ES modules
      const factoryBlocks: string[] = [];
      for (const s of msg.scripts) {
        if (s.kind === 'module') {
          const entryUrl = `${VIRTUAL_ORIGIN}/${s.originPath.replace(/^\/+/, '')}`;
          await this.collectModuleGraph(s.code, s.originPath, entryUrl, factoryBlocks);
        }
      }

      const seedJson = JSON.stringify(msg.seed)
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');

      // Build ordered execution steps for classic & module `<script>` tags.
      //
      // A classic script runs as a script of its own in the page's one global scope, as a
      // browser runs it: by indirect eval, so its `var`s and functions are the page's and the
      // next script can call them. (Each used to be the body of a function of its own, where
      // everything it declared was local: a page with a library in one `<script>` and the code
      // that calls it in the next found nothing defined.) Its `let`, `const` and `class`
      // declarations stay its own, which is where this differs from a browser.
      //
      // A script that throws, or does not parse, says so and the next one still runs.
      const bootSteps: string[] = [];
      for (const s of msg.scripts) {
        if (s.kind === 'classic') {
          // TypeScript is compiled with this program, so a classic TypeScript script stays
          // written into it (text handed to eval at run time would arrive untranslated).
          const body = s.language === 'typescript' ? `\n${s.code}\n` : ` (0, eval)(${JSON.stringify(s.code)}); `;
          bootSteps.push(`__softnBoot = __softnBoot.then(function () {${body}}).then(undefined, __softnScriptFailed);`);
        } else if (s.kind === 'module') {
          const entryUrl = `${VIRTUAL_ORIGIN}/${s.originPath.replace(/^\/+/, '')}`;
          bootSteps.push(
            `__softnBoot = __softnBoot.then(function () { return __softnModules.import(${JSON.stringify(entryUrl)}, ${JSON.stringify(entryUrl)}); }).then(undefined, __softnScriptFailed);`
          );
        }
      }

      const bootstrapSource = [
        ESM_REGISTRY_PREAMBLE,
        shellPrelude(seedJson),
        GUEST_EXTENSIONS_SOURCE,
        // After both: `window` becomes the global object, with what each of them put on it.
        GUEST_BROWSER_GLOBALS_SOURCE,
        // Blob, XMLHttpRequest, WebSocket, images, customElements: over what the three above set up.
        GUEST_WEB_APIS_SOURCE,
        `__softnHydrateInlineHandlers(${JSON.stringify(msg.seed.body)});`,
        ...factoryBlocks,
        // Top-level entry slots callable via `engine.callFunction(name, args)` in O(1)
        `function __softnContainerTake(failed) { return globalThis.__softnDocTake(failed); }`,
        `function __softnContainerSync(changes) { return globalThis.__softnDocSync(changes); }`,
        // The last argument: a box the code's cancelling unticks is told to the page, which
        // ticked it a thread away and hears the answer too late to hold it back.
        `function __softnContainerEvent(id, type, props) { return globalThis.__softnDocEvent(id, type, props, [], true); }`,
        `function __softnContainerRaf(ts) { return globalThis.__softnRunRaf(ts); }`,
        `function __softnContainerWantsRaf() { return globalThis.__softnWantsRaf(); }`,
        `function __softnScriptFailed(err) { console.error('[SoftN] Script startup error:', err && err.stack ? err.stack : String(err)); }`,
        // A warning and an error are one stream to the engine. A warning is written with a
        // mark in front, which drainConsole reads and takes off, so a host hears each as it is.
        `(function () { var c = globalThis.console; if (!c || typeof c.error !== 'function') return; var error = c.error; c.warn = function () { var a = Array.prototype.slice.call(arguments); a.unshift(${JSON.stringify(WARNING_MARK)}); return error.apply(c, a); }; })();`,
        `var __softnBoot = Promise.resolve();`,
        ...bootSteps,
        `__softnBoot.then(function () { globalThis.__softnDocReady(); }, function (err) { __softnScriptFailed(err); globalThis.__softnDocReady(); });`,
      ].join('\n');

      engine.setSyncHostCapabilities([...DB_SYNC_OPS, ...LS_SYNC_OPS, ...APP_SYNC_OPS]);
      engine.setInstructionBudget(this.instructionsPerTurn);
      engine.initSource(bootstrapSource, this.language);

      this.drainTurn();
      this.postToHost({ type: 'ready' });
    } catch (err) {
      this.drainFailedConsole();
      const message = err instanceof Error ? err.message : String(err);
      this.postToHost({ type: 'error', message, phase: 'init', fatal: true });
    }
  }

  private async collectModuleGraph(
    code: string,
    filePath: string,
    moduleUrl: string,
    outBlocks: string[]
  ): Promise<void> {
    if (this.definedModules.has(moduleUrl)) return;
    this.definedModules.add(moduleUrl);

    const { factoryCode, staticImports } = transformEsModule(code, moduleUrl);

    for (const spec of staticImports) {
      const resolved = resolveModuleSpecifier(spec, filePath, this.importMap, (p) => p in this.textFiles);
      if (resolved.kind === 'vfs' && !this.definedModules.has(resolved.url)) {
        const depCode = this.textFiles[resolved.path];
        if (depCode !== undefined) {
          await this.collectModuleGraph(depCode, resolved.path, resolved.url, outBlocks);
        }
      } else if (resolved.kind === 'vendor' && !this.definedModules.has(resolved.url)) {
        const vendorSource = await this.fetchVendorModuleSource(resolved.name);
        if (vendorSource !== null) {
          await this.collectModuleGraph(vendorSource, `vendor/${resolved.name}.js`, resolved.url, outBlocks);
        }
      }
    }

    outBlocks.push(factoryCode);
  }

  private async fetchVendorModuleSource(name: string): Promise<string | null> {
    if (name in this.vendorModules) {
      return this.vendorModules[name];
    }
    const base = this.runtimeUrl.replace(/\/?$/, '/');
    try {
      const resp = await fetch(`${base}vendor/${name}.js`);
      if (resp.ok) return await resp.text();
    } catch {
      // Vendor file not hosted externally
    }
    return null;
  }

  private handleEvent(
    turnId: number,
    nodeId: number,
    eventType: string,
    props: Record<string, unknown>,
    syncChanges?: unknown[]
  ): void {
    if (!this.engine || this.language === 'python') return;
    try {
      this.engine.renewInstructionBudget();
      if (syncChanges && syncChanges.length > 0) {
        this.callGuest('__softnContainerSync', [syncChanges]);
      }
      const bitsRaw = this.callGuest('__softnContainerEvent', [nodeId, eventType, props]);
      const eventBits = typeof bitsRaw === 'number' ? bitsRaw : 0;
      this.drainTurn(turnId, eventBits);
    } catch (err) {
      this.reportGuestError('event', err);
    }
  }

  private handleSync(changes: unknown[]): void {
    if (!this.engine || this.language === 'python' || changes.length === 0) return;
    try {
      this.engine.renewInstructionBudget();
      this.callGuest('__softnContainerSync', [changes]);
      this.drainTurn();
    } catch (err) {
      this.reportGuestError('sync', err);
    }
  }

  /**
   * The app is shown again: the timers that came due while it was not are run, in the order
   * they were set. A repeating timer is armed again by its own turn, so one that ran every
   * 16 ms for an hour unseen runs once here, not 225,000 times.
   */
  private resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const held = [...this.heldTimers.values()];
    this.heldTimers.clear();
    for (const callId of held) {
      if (this.disposed || this.paused) break;
      this.resolveCallbackAndFlush(callId, { ok: true });
    }
    // What arrived on its sockets while it was not shown.
    for (const id of [...this.sockets.keys()]) this.pumpSocket(id);
  }

  private handleRaf(timestamp: number): void {
    if (!this.engine || this.language === 'python') return;
    try {
      this.engine.renewInstructionBudget();
      this.callGuest('__softnContainerRaf', [timestamp]);
      this.drainTurn();
    } catch (err) {
      this.reportGuestError('raf', err);
    }
  }

  private callGuest(fnName: string, args: unknown[]): unknown {
    if (!this.engine) return undefined;
    if (typeof this.engine.callFunction === 'function') {
      return this.engine.callFunction(fnName, args);
    }
    const argJson = args.map((a) => JSON.stringify(a)).join(', ');
    return this.engine.evalInContext(`${fnName}(${argJson})`);
  }

  private drainTurn(turnId?: number, eventBits?: number): void {
    if (!this.engine || this.disposed) return;

    this.engine.pump();
    this.drainConsole();
    this.drainPendingHostCalls();

    // Drain paged ShellOp batches
    const allOps: ShellOp[] = [];
    for (;;) {
      const page = this.callGuest('__softnContainerTake', [false]);
      if (!Array.isArray(page) || page.length === 0) break;
      allOps.push(...(page as ShellOp[]));
    }

    const wantsRaf = Boolean(this.callGuest('__softnContainerWantsRaf', []));

    if (allOps.length > 0 || turnId !== undefined || wantsRaf) {
      this.postToHost({
        type: 'ops',
        ops: allOps,
        ...(turnId !== undefined ? { turnId } : {}),
        ...(eventBits !== undefined ? { eventBits } : {}),
        ...(wantsRaf ? { wantsRaf: true } : {}),
      });
    }
  }

  private drainPendingHostCalls(): void {
    if (!this.engine || this.disposed) return;
    const pending = this.engine.drainPendingHostCalls();
    for (const req of pending) {
      void this.fulfillHostCall(req.id, req.kind, req.args);
    }
  }

  private async fulfillHostCall(callId: number, kind: string, args: string[]): Promise<void> {
    if (this.disposed || !this.engine) return;

    switch (kind) {
      case 'timer.set': {
        const timerId = Number(args[0]);
        const delayMs = Math.max(0, Math.min(Number(args[1]) || 0, 86_400_000));
        const handle = setTimeout(() => {
          this.timers.delete(timerId);
          // Due while the app is not shown: kept, and run when it is shown again.
          if (this.paused) this.heldTimers.set(timerId, callId);
          else this.resolveCallbackAndFlush(callId, { ok: true });
        }, delayMs);
        this.timers.set(timerId, handle);
        return;
      }

      case 'timer.clear': {
        const timerId = Number(args[0]);
        const existing = this.timers.get(timerId);
        if (existing) {
          clearTimeout(existing);
          this.timers.delete(timerId);
        }
        this.heldTimers.delete(timerId);
        return;
      }

      case 'bundle.read': {
        const rawUrl = args[0] ?? '';
        const vfs = resolveVfsPath(rawUrl);
        if (vfs && vfs in this.textFiles) {
          this.resolveCallbackAndFlush(callId, {
            ok: true,
            status: 200,
            headers: { 'content-type': mimeTypeFor(vfs) },
            body: this.textFiles[vfs],
          });
        } else {
          this.resolveCallbackAndFlush(callId, {
            ok: false,
            status: 404,
            error: `Not found in bundle: ${rawUrl}`,
          });
        }
        return;
      }

      case 'esm.load': {
        const specifier = args[0] ?? '';
        const importerUrl = args[1] ?? '';
        const importerPath = importerUrl.startsWith(VIRTUAL_ORIGIN + '/')
          ? importerUrl.slice(VIRTUAL_ORIGIN.length + 1)
          : 'index.html';
        const resolved = resolveModuleSpecifier(
          specifier,
          importerPath,
          this.importMap,
          (p) => p in this.textFiles
        );

        try {
          if (resolved.kind === 'builtin' && this.definedModules.has(resolved.url)) {
            this.resolveCallbackAndFlush(callId, { url: resolved.url });
            return;
          }
          if (resolved.kind === 'vfs') {
            const blocks: string[] = [];
            const src = this.textFiles[resolved.path];
            if (src === undefined) throw new Error(`Module not found in container: ${resolved.path}`);
            await this.collectModuleGraph(src, resolved.path, resolved.url, blocks);
            if (blocks.length > 0 && this.engine) {
              this.engine.renewInstructionBudget();
              this.engine.evalInContext(`(function () {\n${blocks.join('\n')}\n})()`);
            }
            this.resolveCallbackAndFlush(callId, { url: resolved.url });
            return;
          }
          if (resolved.kind === 'vendor') {
            if (!this.definedModules.has(resolved.url)) {
              const vendorSrc = await this.fetchVendorModuleSource(resolved.name);
              if (vendorSrc === null) {
                throw new Error(`Hosted vendor library "${resolved.name}" is not available`);
              }
              const blocks: string[] = [];
              await this.collectModuleGraph(vendorSrc, `vendor/${resolved.name}.js`, resolved.url, blocks);
              if (blocks.length > 0 && this.engine) {
                this.engine.renewInstructionBudget();
                this.engine.evalInContext(`(function () {\n${blocks.join('\n')}\n})()`);
              }
            }
            this.resolveCallbackAndFlush(callId, { url: resolved.url });
            return;
          }
          if (resolved.kind === 'remote') {
            if (
              !isExternalUrlAllowed(
                resolved.url,
                this.permissions.permissions?.net,
                this.grantedCapabilities.has('net')
              )
            ) {
              throw new Error(`Remote module import denied by net permission: ${resolved.url}`);
            }
            if (!this.definedModules.has(resolved.url)) {
              // No redirects, as for the app's own fetches: a host the app was granted could
              // answer with a redirect to one it was not, whose script would then be run.
              const resp = await fetch(resolved.url, { credentials: 'omit', redirect: 'error' });
              if (!resp.ok) throw new Error(`HTTP ${resp.status} loading ${resolved.url}`);
              const remoteSrc = await resp.text();
              const blocks: string[] = [];
              await this.collectModuleGraph(remoteSrc, 'index.html', resolved.url, blocks);
              if (blocks.length > 0 && this.engine) {
                this.engine.renewInstructionBudget();
                this.engine.evalInContext(`(function () {\n${blocks.join('\n')}\n})()`);
              }
            }
            this.resolveCallbackAndFlush(callId, { url: resolved.url });
            return;
          }
        } catch (err) {
          this.resolveCallbackAndFlush(callId, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      case 'net.fetch': {
        const url = args[0] ?? '';
        const rawOpts = args[1] ? (JSON.parse(args[1]) as RequestInit) : {};
        if (
          !isExternalUrlAllowed(
            url,
            this.permissions.permissions?.net,
            this.grantedCapabilities.has('net')
          )
        ) {
          this.resolveCallbackAndFlush(callId, {
            error: `Network access to ${url} is not permitted by this container`,
          });
          return;
        }
        try {
          // A body of bytes (a blob, a form with a file in it) comes as base64: the bridge carries text.
          const bodyBase64 = (rawOpts as { bodyBase64?: unknown }).bodyBase64;
          const resp = await fetch(url, {
            method: rawOpts.method ?? 'GET',
            headers: rawOpts.headers,
            body: typeof bodyBase64 === 'string' ? base64ToBytes(bodyBase64) : rawOpts.body,
            credentials: 'omit',
            redirect: 'error',
          });
          const headersObj: Record<string, string> = {};
          resp.headers.forEach((v, k) => {
            headersObj[k] = v;
          });
          const bytes = new Uint8Array(await resp.arrayBuffer());
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          }
          this.resolveCallbackAndFlush(callId, {
            ok: resp.ok,
            status: resp.status,
            statusText: resp.statusText,
            headers: headersObj,
            base64: btoa(bin),
          });
        } catch (err) {
          this.resolveCallbackAndFlush(callId, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      case 'ws.open': {
        const id = args[0] ?? '';
        const url = args[1] ?? '';
        let protocols: string[] = [];
        try {
          const parsed: unknown = JSON.parse(args[2] ?? '[]');
          if (Array.isArray(parsed)) protocols = parsed.filter((p): p is string => typeof p === 'string').slice(0, 16);
        } catch {
          protocols = [];
        }
        // The rule a request is held to: the network granted, and a host the app declared.
        // A socket's scheme is read as the page scheme it is carried over (wss as https).
        const asPage = /^wss:/i.test(url) ? `https:${url.slice(4)}` : /^ws:/i.test(url) ? `http:${url.slice(3)}` : '';
        if (!asPage || !isExternalUrlAllowed(asPage, this.permissions.permissions?.net, this.grantedCapabilities.has('net'))) {
          this.resolveCallbackAndFlush(callId, { error: `Network access to ${url} is not permitted by this container` });
          return;
        }
        if (this.sockets.has(id) || this.sockets.size >= MAX_SOCKETS) {
          this.resolveCallbackAndFlush(callId, { error: `This container has ${MAX_SOCKETS} sockets open already` });
          return;
        }
        if (typeof WebSocket !== 'function') {
          this.resolveCallbackAndFlush(callId, { error: 'There are no sockets here' });
          return;
        }
        let ws: WebSocket;
        try {
          ws = protocols.length > 0 ? new WebSocket(url, protocols) : new WebSocket(url);
        } catch (err) {
          this.resolveCallbackAndFlush(callId, { error: err instanceof Error ? err.message : String(err) });
          return;
        }
        ws.binaryType = 'arraybuffer';
        const socket: OpenSocket = { ws, events: [], bytes: 0, waiting: null, over: false };
        this.sockets.set(id, socket);
        const heard = (event: Record<string, unknown>, size = 0) => {
          if (socket.over) return;
          socket.events.push(event);
          socket.bytes += size;
          // An app that is not listening (or is hidden for a long while) is not kept bytes for without end.
          if (socket.bytes > MAX_SOCKET_QUEUE_BYTES || socket.events.length > MAX_SOCKET_QUEUE_EVENTS) {
            socket.events = [{ t: 'close', code: 1009, reason: 'Too much arrived unread', wasClean: false }];
            socket.over = true;
            try {
              ws.close();
            } catch {
              // Already closing
            }
          }
          this.pumpSocket(id);
        };
        ws.onopen = () => heard({ t: 'open', protocol: ws.protocol, extensions: ws.extensions });
        ws.onmessage = (e: MessageEvent) => {
          if (typeof e.data === 'string') heard({ t: 'message', data: e.data }, e.data.length * 2);
          else if (e.data instanceof ArrayBuffer) heard({ t: 'message', base64: bytesToBase64(new Uint8Array(e.data)) }, e.data.byteLength * 2);
        };
        ws.onerror = () => heard({ t: 'error' });
        ws.onclose = (e: CloseEvent) => {
          heard({ t: 'close', code: e.code, reason: e.reason, wasClean: e.wasClean });
          socket.over = true;
        };
        this.resolveCallbackAndFlush(callId, { ok: true });
        return;
      }

      case 'ws.next': {
        const id = args[0] ?? '';
        const socket = this.sockets.get(id);
        if (!socket) {
          this.resolveCallbackAndFlush(callId, { error: 'No such socket' });
          return;
        }
        socket.waiting = callId;
        this.pumpSocket(id);
        return;
      }

      case 'ws.send': {
        const socket = this.sockets.get(args[0] ?? '');
        if (!socket || socket.ws.readyState !== 1) return;
        const data = args[2] ?? '';
        if (data.length > MAX_SOCKET_MESSAGE_CHARS) return;
        try {
          socket.ws.send(args[1] === 'base64' ? base64ToBytes(data) : data);
        } catch {
          // The socket closed between the check and the send: its close is told as it comes.
        }
        return;
      }

      case 'ws.close': {
        const socket = this.sockets.get(args[0] ?? '');
        if (!socket) return;
        const code = Number(args[1]);
        try {
          if (Number.isInteger(code) && (code === 1000 || (code >= 3000 && code <= 4999))) socket.ws.close(code, (args[2] ?? '').slice(0, 123));
          else socket.ws.close();
        } catch {
          // Already closed
        }
        return;
      }

      default:
        this.resolveCallbackAndFlush(callId, { error: `Unsupported host call: ${kind}` });
    }
  }

  /** Hand a socket's waiting events to the app, when it has asked for them and is shown. */
  private pumpSocket(id: string): void {
    const socket = this.sockets.get(id);
    if (!socket || socket.waiting === null || socket.events.length === 0 || this.paused || this.disposed) return;
    const callId = socket.waiting;
    socket.waiting = null;
    const events = socket.events;
    socket.events = [];
    socket.bytes = 0;
    if (events.some((event) => event.t === 'close')) this.sockets.delete(id);
    this.resolveCallbackAndFlush(callId, { events });
  }

  private resolveCallbackAndFlush(callId: number, result: unknown): void {
    if (this.disposed || !this.engine) return;
    try {
      this.engine.renewInstructionBudget();
      this.engine.resolveHostCallback(callId, result);
      this.drainTurn();
    } catch (err) {
      this.reportGuestError('async-callback', err);
    }
  }

  private installBridges(engine: ZippEngineInstance): void {
    // 1. Worker-local synchronous `localStorage` (zipp-wasm JSON-encodes return values automatically)
    engine.setLocalStorageBridge({
      getItem: (keyRaw: unknown) => {
        const key = String(keyRaw ?? '');
        const val = this.localStore.get(key);
        return val === undefined ? null : val;
      },
      setItem: (keyRaw: unknown, valRaw: unknown) => {
        const key = String(keyRaw ?? '');
        const val = String(valRaw ?? '');
        const prev = this.localStore.get(key);
        const delta = (key.length + val.length) * 2 - (prev !== undefined ? (key.length + prev.length) * 2 : 0);
        // One quota for what the app keeps: its records take from it too (`recordBytesKept`).
        // They were left out here, so an app with its records at the quota could keep as much
        // again this way; the page now refuses that, and the app must be told, not left
        // believing a value was kept that is gone at the next visit.
        if (this.localStoreBytes + delta + this.recordBytesKept > this.storageQuotaBytes) {
          throw new Error('QuotaExceededError: container localStorage quota exceeded');
        }
        this.localStore.set(key, val);
        this.localStoreBytes += delta;
        this.postToHost({ type: 'storage-write', op: 'set', key, value: val });
      },
      removeItem: (keyRaw: unknown) => {
        const key = String(keyRaw ?? '');
        const prev = this.localStore.get(key);
        if (prev !== undefined) {
          this.localStore.delete(key);
          this.localStoreBytes -= (key.length + prev.length) * 2;
          this.postToHost({ type: 'storage-write', op: 'remove', key });
        }
      },
      clear: () => {
        this.localStore.clear();
        this.localStoreBytes = 0;
        this.postToHost({ type: 'storage-write', op: 'clear' });
      },
    });

    // 2. Worker-local synchronous `db.*` (100% off the main thread!)
    const getCollection = (name: string): Map<string, DbRecord> => {
      let col = this.dbCollections.get(name);
      if (!col) {
        col = new Map();
        this.dbCollections.set(name, col);
      }
      return col;
    };
    // The app's records count against the same quota as its localStorage: both are kept in
    // the embedding page's storage, which is the page's to run out of. (Only localStorage was
    // counted, so an app could write records until the page's own keys had no room.) Counted
    // as the page counts them, by the one text they are kept as, so that the two agree on
    // the write that does not fit.
    const persistCollection = (name: string) => {
      const records = this.recordBytes();
      if (this.localStoreBytes + records > this.storageQuotaBytes) {
        throw new Error('QuotaExceededError: container storage quota exceeded');
      }
      this.recordBytesKept = records;
      const col = getCollection(name);
      this.postToHost({ type: 'db-write', collection: name, records: [...col.values()] });
    };
    /**
     * Keep a change to a collection, or take it back: a change the quota refuses is undone
     * before the app hears of it. It used to stay in the Worker's own copy, where the app
     * went on reading a record the page had not kept, and where every later change, a
     * delete included, was refused in turn because the copy was still over the quota.
     */
    const commit = (name: string, undo: () => void): void => {
      try {
        persistCollection(name);
      } catch (err) {
        undo();
        throw err;
      }
    };

    engine.setDbBridge({
      query: (collectionRaw: unknown, optsRaw: unknown) => {
        const collection = String(collectionRaw ?? '');
        const col = getCollection(collection);
        const opts =
          optsRaw && typeof optsRaw === 'object'
            ? (optsRaw as { filter?: Record<string, unknown> })
            : typeof optsRaw === 'string' && optsRaw
              ? (JSON.parse(optsRaw) as { filter?: Record<string, unknown> } | null)
              : null;
        return [...col.values()].filter((r) => {
          if (r._deleted) return false;
          if (opts?.filter) {
            for (const [fk, fv] of Object.entries(opts.filter)) {
              if (r[fk] !== fv) return false;
            }
          }
          return true;
        });
      },
      get: (collectionRaw: unknown, idRaw: unknown) => {
        const rec = getCollection(String(collectionRaw ?? '')).get(String(idRaw ?? ''));
        return rec && !rec._deleted ? rec : null;
      },
      create: (collectionRaw: unknown, dataRaw: unknown) => {
        const collection = String(collectionRaw ?? '');
        const data =
          dataRaw && typeof dataRaw === 'object'
            ? (dataRaw as Record<string, unknown>)
            : typeof dataRaw === 'string' && dataRaw
              ? (JSON.parse(dataRaw) as Record<string, unknown>)
              : {};
        const now = new Date().toISOString();
        const id =
          typeof data.id === 'string' && data.id
            ? data.id
            : `rec_${Date.now().toString(36)}_${(this.dbRecordSeq++).toString(36)}`;
        const rec: DbRecord = { ...data, id, created_at: now, updated_at: now };
        const col = getCollection(collection);
        const before = col.get(id);
        col.set(id, rec);
        commit(collection, () => {
          if (before) col.set(id, before);
          else col.delete(id);
        });
        return rec;
      },
      update: (idRaw: unknown, dataRaw: unknown) => {
        const id = String(idRaw ?? '');
        const patch =
          dataRaw && typeof dataRaw === 'object'
            ? (dataRaw as Record<string, unknown>)
            : typeof dataRaw === 'string' && dataRaw
              ? (JSON.parse(dataRaw) as Record<string, unknown>)
              : {};
        for (const [colName, col] of this.dbCollections) {
          const existing = col.get(id);
          if (existing && !existing._deleted) {
            const updated: DbRecord = {
              ...existing,
              ...patch,
              id: existing.id,
              updated_at: new Date().toISOString(),
            };
            col.set(id, updated);
            commit(colName, () => col.set(id, existing));
            return updated;
          }
        }
        return null;
      },
      delete: (idRaw: unknown) => {
        const id = String(idRaw ?? '');
        for (const [colName, col] of this.dbCollections) {
          const existing = col.get(id);
          if (existing) {
            // A new record in the old one's place, so that the old one is there to put back.
            col.set(id, { ...existing, _deleted: true, updated_at: new Date().toISOString() });
            commit(colName, () => col.set(id, existing));
            break;
          }
        }
      },
      hardDelete: (collectionRaw: unknown, idRaw: unknown) => {
        const collection = String(collectionRaw ?? '');
        const col = getCollection(collection);
        const existing = col.get(String(idRaw ?? ''));
        if (existing && col.delete(existing.id)) commit(collection, () => col.set(existing.id, existing));
      },
      startSync: () => undefined,
      stopSync: () => undefined,
      getSyncStatus: () => ({ connected: false, peers: 0 }),
      getSavedSyncRoom: () => null,
    });

    // 3. Synchronous VFS & ES Module Resolver bridge (`call(kind, args)` per zipp-wasm setAppBridge contract)
    engine.setAppBridge({
      call: (kindRaw: unknown, argsRaw: unknown) => {
        const kind = String(kindRaw ?? '');
        const args = Array.isArray(argsRaw) ? argsRaw : [];
        if (kind === 'esm.resolve') {
          const specifier = String(args[0] ?? '');
          const importerUrl = String(args[1] ?? '');
          const importerPath = importerUrl.startsWith(VIRTUAL_ORIGIN + '/')
            ? importerUrl.slice(VIRTUAL_ORIGIN.length + 1)
            : 'index.html';
          const res = resolveModuleSpecifier(
            specifier,
            importerPath,
            this.importMap,
            (p) => p in this.textFiles
          );
          return res.url;
        }
        if (kind === 'vfs.fetch') {
          const rawUrl = String(args[0] ?? '');
          const basePath = String(args[1] || '/index.html').replace(/^\/+/, '') || 'index.html';
          const vfsPath = resolveVfsPath(rawUrl, basePath);
          if (!vfsPath) {
            return { ok: false, status: 400, statusText: 'Bad Path', headers: {} };
          }
          if (vfsPath in this.textFiles) {
            return {
              ok: true,
              status: 200,
              statusText: 'OK',
              headers: { 'content-type': mimeTypeFor(vfsPath) },
              body: this.textFiles[vfsPath],
            };
          }
          if (vfsPath in this.binaryFiles) {
            return {
              ok: true,
              status: 200,
              statusText: 'OK',
              headers: { 'content-type': mimeTypeFor(vfsPath) },
              // Written out here, off the page's thread, and only for a file a script reads.
              base64: bytesToBase64(this.binaryFiles[vfsPath]),
            };
          }
          return { ok: false, status: 404, statusText: 'Not Found', headers: {} };
        }
        throw new Error(`Unknown sync app operation: ${kind}`);
      },
    });
  }

  /**
   * What the app's records take in the embedding page's storage, in bytes: the one text the
   * page keeps them all as (softn-app.ts's savePersistedDbCollection), counted the same way.
   */
  private recordBytes(): number {
    if (this.dbCollections.size === 0) return 0;
    // No prototype: a collection may be called `__proto__`, and is counted like any other.
    const all: Record<string, DbRecord[]> = Object.create(null);
    for (const [name, col] of this.dbCollections) all[name] = [...col.values()];
    return JSON.stringify(all).length * 2;
  }

  private seedDatabase(persisted: Record<string, unknown[]>): void {
    // 1. Seed from `.xdb` files in the container archive first
    for (const [path, content] of Object.entries(this.textFiles)) {
      if (!/\.xdb$/i.test(path)) continue;
      try {
        const parsed = JSON.parse(content) as { collection?: string; records?: unknown[] } | unknown[];
        const baseName = path.slice(path.lastIndexOf('/') + 1).replace(/\.xdb$/i, '');
        const colName = !Array.isArray(parsed) && typeof parsed.collection === 'string' ? parsed.collection : baseName;
        const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.records) ? parsed.records : [];
        const col = new Map<string, DbRecord>();
        for (const item of list) {
          if (item && typeof item === 'object') {
            const rec = item as DbRecord;
            const id = rec.id || `seed_${this.dbRecordSeq++}`;
            const envelopeData =
              rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)
                ? (rec.data as Record<string, unknown>)
                : undefined;
            col.set(id, envelopeData ? { ...envelopeData, ...rec, id } : { ...rec, id });
          }
        }
        this.dbCollections.set(colName, col);
      } catch {
        // Ignore malformed seed file
      }
    }
    // 2. Overlay persisted user records
    for (const [colName, list] of Object.entries(persisted)) {
      const col = this.dbCollections.get(colName) ?? new Map<string, DbRecord>();
      for (const item of list) {
        if (item && typeof item === 'object' && 'id' in item) {
          const rec = item as DbRecord;
          col.set(rec.id, rec);
        }
      }
      this.dbCollections.set(colName, col);
    }
  }

  private drainConsole(): void {
    if (!this.engine) return;
    for (;;) {
      const entries = this.engine.takeConsole();
      if (!Array.isArray(entries) || entries.length === 0) break;
      for (const entry of entries) {
        // The engine says which stream a line was written to, not which console method wrote
        // it: `{ stream: "stdout" | "stderr", text }`. This read a `level` the engine never
        // gave, so every line an app printed, its errors too, reached the host as a plain
        // log: nothing a host shows or counts as an error (Studio's check of an app) saw one.
        const text = String(entry.text ?? '');
        if (entry.stream !== 'stderr') this.postToHost({ type: 'console', level: 'log', text });
        else if (text.startsWith(WARNING_MARK)) this.postToHost({ type: 'console', level: 'warn', text: text.slice(WARNING_MARK.length).replace(/^ /, '') });
        else this.postToHost({ type: 'console', level: 'error', text });
      }
    }
  }

  private drainFailedConsole(): void {
    if (!this.engine) return;
    try {
      for (;;) {
        const entries = this.engine.takeFailedConsole();
        if (!Array.isArray(entries) || entries.length === 0) break;
        for (const entry of entries) {
          const text = String(entry.text ?? '');
          this.postToHost({ type: 'console', level: 'error', text: text.startsWith(WARNING_MARK) ? text.slice(WARNING_MARK.length).replace(/^ /, '') : text });
        }
      }
    } catch {
      // Engine already freed
    }
  }

  private reportGuestError(phase: string, err: unknown): void {
    this.drainConsole();
    const message = err instanceof Error ? err.message : String(err);
    const fatal = Boolean(this.engine?.disposed);
    this.postToHost({ type: 'error', message, phase, fatal });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const socket of this.sockets.values()) {
      socket.over = true;
      try {
        socket.ws.close();
      } catch {
        // Already closed
      }
    }
    this.sockets.clear();
    if (this.engine) {
      try {
        this.engine.dispose();
      } catch {
        // Ignore
      }
      try {
        this.engine.free?.();
      } catch {
        // Ignore
      }
      this.engine = null;
    }
  }
}
