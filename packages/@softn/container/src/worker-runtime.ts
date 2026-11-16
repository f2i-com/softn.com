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
import { mimeTypeFor, resolveVfsPath, VIRTUAL_ORIGIN } from './archive';
import {
  ESM_REGISTRY_PREAMBLE,
  resolveModuleSpecifier,
  transformEsModule,
} from './esm-linker';
import { GUEST_EXTENSIONS_SOURCE } from './guest-canvas-and-ext';
import { isExternalUrlAllowed } from './sanitize';
import { loadZippEngine, type ZippEngineInstance } from './zipp-loader';
import type {
  ContainerPermissions,
  HostToWorkerMsg,
  ShellOp,
  WorkerToHostMsg,
} from './types';
import type { Capability } from '@softn/bundle-format/capabilities';

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
  private binaryFilesBase64: Record<string, string> = {};
  private importMap: Record<string, string> = {};
  private vendorModules: Record<string, string> = {};
  private runtimeUrl = '/runtime/';
  private permissions: ContainerPermissions = {};
  private grantedCapabilities = new Set<Capability>();
  private instructionsPerTurn = 100_000_000;
  private storageQuotaBytes = 10 * 1024 * 1024;
  private language: 'javascript' | 'typescript' | 'python' = 'javascript';

  private readonly localStore = new Map<string, string>();
  private localStoreBytes = 0;
  private readonly dbCollections = new Map<string, Map<string, DbRecord>>();
  private dbRecordSeq = 1;

  private readonly definedModules = new Set<string>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
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
      case 'dispose':
        this.dispose();
        break;
    }
  }

  private async handleInit(msg: Extract<HostToWorkerMsg, { type: 'init' }>): Promise<void> {
    this.textFiles = { ...msg.textFiles };
    this.binaryFilesBase64 = { ...msg.binaryFilesBase64 };
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
        `__softnHydrateInlineHandlers(${JSON.stringify(msg.seed.body)});`,
        ...factoryBlocks,
        // Top-level entry slots callable via `engine.callFunction(name, args)` in O(1)
        `function __softnContainerTake(failed) { return globalThis.__softnDocTake(failed); }`,
        `function __softnContainerSync(changes) { return globalThis.__softnDocSync(changes); }`,
        `function __softnContainerEvent(id, type, props) { return globalThis.__softnDocEvent(id, type, props, []); }`,
        `function __softnContainerRaf(ts) { return globalThis.__softnRunRaf(ts); }`,
        `function __softnContainerWantsRaf() { return globalThis.__softnWantsRaf(); }`,
        `function __softnScriptFailed(err) { console.error('[SoftN] Script startup error:', err && err.stack ? err.stack : String(err)); }`,
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
          this.resolveCallbackAndFlush(callId, { ok: true });
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
          const resp = await fetch(url, {
            method: rawOpts.method ?? 'GET',
            headers: rawOpts.headers,
            body: rawOpts.body,
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

      default:
        this.resolveCallbackAndFlush(callId, { error: `Unsupported host call: ${kind}` });
    }
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
        if (this.localStoreBytes + delta > this.storageQuotaBytes) {
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
    // counted, so an app could write records until the page's own keys had no room.)
    const persistCollection = (name: string) => {
      let bytes = this.localStoreBytes;
      for (const col of this.dbCollections.values()) {
        for (const rec of col.values()) bytes += JSON.stringify(rec).length * 2;
      }
      if (bytes > this.storageQuotaBytes) {
        throw new Error('QuotaExceededError: container storage quota exceeded');
      }
      const col = getCollection(name);
      this.postToHost({ type: 'db-write', collection: name, records: [...col.values()] });
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
        getCollection(collection).set(id, rec);
        persistCollection(collection);
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
            persistCollection(colName);
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
            existing._deleted = true;
            existing.updated_at = new Date().toISOString();
            persistCollection(colName);
            break;
          }
        }
      },
      hardDelete: (collectionRaw: unknown, idRaw: unknown) => {
        const collection = String(collectionRaw ?? '');
        const col = getCollection(collection);
        if (col.delete(String(idRaw ?? ''))) persistCollection(collection);
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
          if (vfsPath in this.binaryFilesBase64) {
            return {
              ok: true,
              status: 200,
              statusText: 'OK',
              headers: { 'content-type': mimeTypeFor(vfsPath) },
              base64: this.binaryFilesBase64[vfsPath],
            };
          }
          return { ok: false, status: 404, statusText: 'Not Found', headers: {} };
        }
        throw new Error(`Unknown sync app operation: ${kind}`);
      },
    });
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
        const lvl =
          entry.level === 'error' || entry.level === 'warn' || entry.level === 'info'
            ? entry.level
            : 'log';
        this.postToHost({ type: 'console', level: lvl, text: entry.text });
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
          this.postToHost({ type: 'console', level: 'error', text: entry.text });
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
