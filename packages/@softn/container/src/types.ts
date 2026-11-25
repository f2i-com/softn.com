import type { Capability } from '@softn/bundle-format/capabilities';
import type { ContainerDeviceBridge } from './device-bridge';

/** How the container executes the bundle. */
export type ContainerMode = 'web' | 'legacy-ui';

/**
 * Tiered ZIPP WASM engine variants, ordered from lightest to richest.
 * Default is `'lite'` (~778 KB Brotli, 1 MiB stack).
 */
export type ZippEngineTier =
  | 'lite'
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'python-torch'
  | 'php'
  | 'rust';

/** Supported embedded backend runtime languages running inside the Backend Worker on ZIPP WASM. */
export type BackendRuntimeKind = 'rust' | 'php' | 'javascript' | 'typescript' | 'python';

/** Declarative URL rewrite rule (can come from `manifest.json` or parsed `.htaccess`). */
export interface RewriteRule {
  match: string;
  to: string;
  flags?: string[];
}

/** Embedded backend configuration (explicit in `manifest.json` or zero-config auto-discovered). */
export interface BackendConfig {
  runtime: BackendRuntimeKind;
  /** Entry script or source file inside the archive (e.g. `"server/src/main.rs"`, `"index.php"`, `"backend/server.js"`). */
  entry: string;
  /** Optional directory prefix containing backend source files (e.g. `"server"`, `"backend"`, `""` for root PHP). */
  root?: string;
  /**
   * Execution model:
   * - `'ssr'`: backend renders HTML pages AND handles API routes (e.g. PHP apps like Sngine)
   * - `'api'`: static/SPA frontend (`index.html`) talks to backend over HTTP/WS API routes (e.g. React + Rust Axum)
   */
  mode?: 'api' | 'ssr';
  /** Path prefixes routed to this backend (default `['/api/', '/ws']` in `'api'` mode, `['/']` in `'ssr'` mode). */
  routes?: string[];
  /**
   * External origins (e.g. `['http://localhost:8080', 'http://127.0.0.1:8080']`) whose frontend
   * `fetch()` / `XHR` / `WebSocket` requests are transparently intercepted and routed to the
   * sandboxed backend with zero external network egress!
   */
  interceptOrigins?: string[];
  /** Environment variables passed to the backend runtime (e.g. `PIT_DB_PATH`, `APP_ENV`). */
  env?: Record<string, string>;
  /** Explicit URL rewrite rules (in addition to any `.htaccess` files in the archive). */
  rewrites?: RewriteRule[];
  /** For PHP: `'sapi'` (shared-nothing per request, default) or `'worker'` (`zipp_handle_requests`). */
  phpMode?: 'sapi' | 'worker';
}

/** SQLite database configuration backed by XDB WASM (`xdb-rs`). */
export interface DatabaseConfig {
  /** Logical database name (e.g. `"app"`, `"pit"`). */
  name: string;
  engine?: 'sqlite';
  /** Archive path or virtual filename (e.g. `"data/app.db"` or `"pit.db"`). */
  file?: string;
  /** Optional SQL DDL/seed script (inline SQL or archive path like `"db/schema.sql"`). */
  seedSql?: string;
  /** Optional JSON seed data (inline object/JSON string or archive path like `"db/seed.json"`). */
  seedJson?: string | Record<string, unknown>;
  /** Whether writes persist to host IndexedDB across reloads (default `true`). */
  persist?: boolean;
}

/** Transport-agnostic HTTP request crossing the Frontend <-> Backend boundary (FormLogic-compatible). */
export interface BackendHttpRequest {
  method: string;
  /** Normalized pathname starting with `/` (e.g. `"/api/v1/health"`, `"/signin"`). */
  path: string;
  /** Query string without leading `?`. */
  query?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  /** Original requested URL (for `Origin` / `Host` / rewrite context). */
  url?: string;
}

/** Transport-agnostic HTTP response from a local WASM backend or remote FormLogic backend. */
export interface BackendHttpResponse {
  status: number;
  statusText?: string;
  headers: Array<[string, string]>;
  body: Uint8Array;
}

export type BackendWsEvent =
  | { type: 'open'; protocol?: string }
  | { type: 'message'; data: string | Uint8Array }
  | { type: 'error'; message?: string }
  | { type: 'close'; code?: number; reason?: string; wasClean?: boolean };

export interface BackendWsHandle {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** Live startup progress emitted during container & embedded backend boot. */
export interface ContainerBootStatus {
  phase:
    | 'opening'
    | 'loading-sqlite'
    | 'hydrating-db'
    | 'loading-backend-runtime'
    | 'booting-backend'
    | 'backend-ready'
    | 'starting-frontend'
    | 'ready';
  message: string;
  /** Progress percentage `0..100`. */
  percent?: number;
  /** Optional extra detail (e.g., runtime name, database name, migration/seed log). */
  detail?: string;
}

/**
 * Clean Frontend <-> Backend boundary.
 *
 * By default SoftN constructs a `LocalBackendTransport` running the bundled backend
 * inside an isolated Web Worker on ZIPP WASM + XDB SQLite. Later, FormLogic can inject
 * a remote multi-user `BackendTransport` without changing any app code!
 */
export interface BackendTransport {
  readonly kind: 'local-worker' | 'local-inline' | 'remote';
  readonly ready: Promise<void>;
  fetch(req: BackendHttpRequest): Promise<BackendHttpResponse>;
  openWebSocket?(
    path: string,
    protocols: string[],
    onEvent: (event: BackendWsEvent) => void
  ): BackendWsHandle;
  /** Apply JSON seed data dynamically to a named database (local transports). */
  seedDatabase?(dbName: string, seedJson: string | Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Export a named database's live SQLite `.db` bytes (local transports). */
  exportDatabase?(dbName: string): Promise<Uint8Array | null>;
  dispose(): void;
}

/** One entry returned by virtual folder navigation (`listVirtualDirectory`). */
export interface VirtualDirEntry {
  name: string;
  /** Normalized virtual path (e.g. `"modules/sign.php"` or `"modules"`). */
  path: string;
  /** Virtual URL path starting with `/` (e.g. `"/modules/sign.php"` or `"/modules/"`). */
  urlPath: string;
  kind: 'dir' | 'file';
  /** Whether navigating to this entry executes a script or renders a page (`.php`, `.html`, etc.). */
  navigable: boolean;
  /** File extension without dot (lowercase). */
  ext?: string;
  size?: number;
}

/** Network allowlist configuration from `permission.json`. */
export interface NetPermission {
  enabled?: boolean;
  allowed_hosts?: string[];
  allow_http?: boolean;
}

/** Capability map carried by `permission.json`. */
export interface ContainerPermissions {
  permissions?: {
    net?: NetPermission;
    camera?: { enabled?: boolean };
    mic?: { enabled?: boolean; maxSeconds?: number };
    files?: { enabled?: boolean };
    qr?: { enabled?: boolean };
    ai?: { enabled?: boolean };
    gpu?: { enabled?: boolean };
    sync?: { enabled?: boolean; roomCollections?: string[] };
    storage?: { enabled?: boolean; collections?: Record<string, string> };
    accel?: { enabled?: boolean };
    bluetooth?: { enabled?: boolean; services?: string[] };
    location?: { enabled?: boolean; precision?: 'coarse' | 'fine' };
    haptics?: { enabled?: boolean };
    notifications?: { enabled?: boolean };
    [key: string]: { enabled?: boolean } | object | undefined;
  };
}

/** Normalized container manifest (explicit `manifest.json` or zero-config inferred). */
export interface ContainerManifest {
  id: string;
  name: string;
  version: string;
  main: string;
  icon?: string;
  mode: ContainerMode;
  inferred: boolean;
  importMap: Record<string, string>;
  pythonPackages?: string[];
  theme?: 'light' | 'dark' | 'auto';
  /** Optional embedded backend configuration (Rust, PHP, JS/TS, Python). */
  backend?: BackendConfig;
  /** Optional directory prefix for frontend static files inside a full-stack archive (e.g. `"app/dist"`). */
  frontendRoot?: string;
  /** Optional SQLite databases managed by XDB WASM (`xdb-rs`). */
  databases?: DatabaseConfig[];
  /** Whether the initial HTML document is rendered dynamically by the backend (`GET /`). */
  ssrEntry?: boolean;
  raw?: Record<string, unknown>;
}

/** Standard ES import map structure. */
export interface ImportMapConfig {
  imports?: Record<string, string>;
  scopes?: Record<string, Record<string, string>>;
}

/** One `<script>` extracted from the HTML document in execution order. */
export interface ExtractedScript {
  id: number;
  kind: 'classic' | 'module' | 'python';
  language: 'javascript' | 'typescript' | 'python';
  src?: string;
  code: string;
  originPath: string;
  /** Human-facing source file path for stack/error reporting (e.g. `about.html` for inline scripts). */
  displayFile?: string;
  /** 1-based starting line inside `displayFile` (`1` for external scripts, tag line for inline HTML scripts). */
  startLine?: number;
  /** Run after the page's other scripts, as a browser runs a deferred one: a module, or a classic script by its address with `defer` (neither `async`). */
  defer?: boolean;
}

/**
 * One `<script>` of the page, put in the app's document where it was (inert: run already, or
 * never to be). `a` its attributes, `x` its text when it is not run (a template, JSON), `p` its
 * parent (`'head'`, or the id of a node of the seed, 1 the body), `b` the node it came before
 * (null: last), `r` the id of the `ExtractedScript` it was, when it is run.
 */
export interface PlacedScript {
  a: Array<[string, string]>;
  x?: string;
  p: 'head' | number;
  b: number | null;
  r: number | null;
}

/** Seed node passed to the Worker's guest DOM on startup. */
export interface SeedNode {
  /** Assigned integer node ID (0 = html, 1 = body, >=2 = content). */
  i: number;
  /** Element tag name. */
  t?: string;
  /** Static attributes (excluding `on*` handlers, which never stay on the host). */
  a?: Record<string, string>;
  /** Inline `on*` handler sources (`onclick="..."`) to compile inside ZIPP only. */
  h?: Record<string, string>;
  /** Namespace if non-HTML (`'svg'` | `'math'`). */
  ns?: 'svg' | 'math';
  /** Child seed nodes. */
  c?: SeedNode[];
  /** Text node content. */
  x?: string;
  /** Island marker (custom host-managed `<softn-*>` widget). */
  o?: 1;
  /** `<template>` inert content tree. */
  tpl?: SeedNode[];
}

/** Viewport tuple: [width, height, dark(0|1), reducedMotion(0|1), dpr, coarsePointer(0|1)]. */
export type ViewportTuple = [number, number, 0 | 1, 0 | 1, number, 0 | 1];

/** Initial document seed sent from `<softn-app>` to the Worker. */
export interface ShellSeed {
  next: number;
  body: SeedNode[];
  htmlAttrs?: Record<string, string>;
  bodyAttrs?: Record<string, string>;
  title?: string;
  url?: string;
  r?: number[];
  v?: ViewportTuple;
  /** This host draws shadow trees: an element of the app's has `attachShadow`. */
  shadow?: boolean;
}

/** Compact 2D `<canvas>` command tuple replayed on the host `<canvas>`. */
export type Canvas2DCmd =
  | ['prop', string, string | number]
  | ['grad', 'fillStyle' | 'strokeStyle', 'linear' | 'radial', number[], Array<[number, string]>]
  | ['clearRect', number, number, number, number]
  | ['fillRect', number, number, number, number]
  | ['strokeRect', number, number, number, number]
  | ['beginPath']
  | ['closePath']
  | ['moveTo', number, number]
  | ['lineTo', number, number]
  | ['arc', number, number, number, number, number, boolean?]
  | ['ellipse', number, number, number, number, number, number, number, boolean?]
  | ['rect', number, number, number, number]
  | ['roundRect', number, number, number, number, number | number[]]
  | ['quadraticCurveTo', number, number, number, number]
  | ['bezierCurveTo', number, number, number, number, number, number]
  | ['fill', string?]
  | ['stroke']
  | ['clip', string?]
  | ['save']
  | ['restore']
  | ['scale', number, number]
  | ['rotate', number]
  | ['translate', number, number]
  | ['transform', number, number, number, number, number, number]
  | ['setTransform', number, number, number, number, number, number]
  | ['resetTransform']
  | ['setLineDash', number[]]
  | ['fillText', string, number, number, number?]
  | ['strokeText', string, number, number, number?]
  | ['putImageData', string, number, number, number, number]
  | ['drawImage', string, number, number, number?, number?, number?, number?, number?, number?];

/** Split-realm Three.js scene operations sent from Worker `import * as THREE from 'three'` to host WebGL2. */
export type ThreeSceneOp =
  | ['init', { antialias?: boolean; alpha?: boolean; clearColor?: number | string; clearAlpha?: number }]
  | ['clearColor', number | string, number]
  | ['resize', number, number, number]
  | ['camera', number, 'perspective' | 'orthographic', number[]]
  | ['lookAt', number, [number, number, number]]
  | ['mesh', number, { geo: [string, ...number[]]; mat: Record<string, unknown> }]
  | ['light', number, string, { color?: number | string; intensity?: number; pos?: [number, number, number] }]
  | ['group', number]
  | ['gltf', number, string]
  | ['add', number, number]
  | ['remove', number, number]
  | ['xform', number, [number, number, number], [number, number, number], [number, number, number]]
  | ['mat', number, Record<string, unknown>]
  | ['dispose', number]
  | ['render', number, number];

/** Batched DOM / Canvas / Scene mutation tuple emitted by the Worker at the end of a turn. */
export type ShellOp =
  | ['e', number, string, Record<string, string>, ('svg' | 'math')?]
  /** A shadow root the script attached: the element it is attached to, and the root's own id. */
  | ['sr', number, number]
  | ['x', number, string]
  | ['m', number]
  | ['a', number, string, string | null]
  | ['c', number, number[]]
  | ['p', number, string, unknown]
  | ['l', string]
  | ['t', string]
  | ['n', string]
  /** A blob the script made an address for: its id, its type, its bytes in base64 (or in pieces, for a part of a picked file); and one let go. */
  | ['blob', string, string, string | Array<{ base64: string; skip?: number; take?: number }>]
  | ['unblob', string]
  /** An image that is not on the page, for the host to load and say when it has: a token to answer by, and the address. */
  | ['img', string, string, string?]
  /** An animation of an element (`element.animate`): its key, the element, its keyframes and its timing; and what the script then asks of it. */
  | ['anim', string, number, unknown, unknown]
  | ['anim-ctl', string, string]
  /** A canvas's picture asked for as a file: a token to answer by, the canvas, the kind of picture and its quality (-1 for the browser's own). */
  | ['canvas-blob', string, number, string, number]
  /** A file the script asks to save: the id of a blob it made an address for, and the name it gives the file. */
  | ['save', string, string]
  /** A canvas's drawing since the last turn; 'mirrored' when the Worker has drawn it on its own copy already (the app read the canvas back). */
  | ['k2d', number, number, number, Canvas2DCmd[], 'mirrored'?]
  /** A canvas's size set by the app: it is cleared, even at the size it had, in its place among what was drawn. */
  | ['k2dreset', number, number, number, 'mirrored'?]
  /** A canvas the app can no longer reach: what the page and the Worker keep for it is let go of. */
  | ['k2dgone', number]
  | ['3d', number, ThreeSceneOp[]];

/** A file an app asks to save. */
export interface SaveRequest {
  /** The name the file is saved under: the app's, with what a file name cannot hold taken out. */
  name: string;
  /** The type the app gave the blob. */
  type: string;
  size: number;
  bytes: Uint8Array;
}

/** Measured bounding rect tuple: [id, x, y, width, height], plus optional scrollWidth, scrollHeight, offsetLeft, offsetTop. */
export type MeasuredBoxTuple = [number, number, number, number, number, number?, number?, number?, number?];

/** Resource & execution limits applied to each container Worker. */
export interface ContainerLimits {
  /** Max VM bytecode instructions per turn (default 100,000,000). */
  instructionsPerTurn?: number;
  /** Wall-clock timeout in ms before terminating a hung Worker turn (default 15,000). */
  turnTimeoutMs?: number;
  /** What the app may keep, its localStorage and its records together, in bytes (default 5 MB: half of what a browser gives the page). */
  storageQuotaBytes?: number;
  /**
   * What the app's IndexedDB databases may take, in bytes, where the page keeps them in its own
   * IndexedDB (default 64 MB). Where the page has none, they are kept in its localStorage and
   * counted in `storageQuotaBytes` with the rest.
   */
  idbQuotaBytes?: number;
}

/** A ZIPP engine as a host can hand it over: bytes, a compiled module, or an address to fetch. */
export type ZippEngineSource = BufferSource | WebAssembly.Module | string;

/** An engine, or a function that answers one when its tier is first needed. */
export type ZippEngineSupplier = ZippEngineSource | (() => ZippEngineSource | Promise<ZippEngineSource>);

/** Extracted per-page SEO metadata from a guest HTML document's `<head>` and `<html>`. */
export interface ContainerPageMeta {
  title?: string;
  description?: string;
  robots?: string;
  lang?: string;
}

/** Configuration for mounting a SoftN v2 container. */
export interface SoftNContainerOptions {
  /** `.softn` ZIP bytes, URL to a `.softn` archive, or unpacked file map. */
  source: Uint8Array | ArrayBuffer | string | Record<string, string | Uint8Array>;
  /** Optional pre-verified SHA-256 hex digest of `source` bytes (skips redundant full-bundle hashing). */
  precomputedDigest?: string;
  /** Base URL where `/runtime/` assets (`engines/`, `vendor/`, `ui/`, `compat/`) are served. */
  runtimeUrl?: string;
  /** Dedicated-worker entry in the host's service-worker scope when its runtime files are shared. */
  workerUrl?: string;
  /**
   * A tier's engine from the host instead of from `runtimeUrl`'s `engines/` folder: its bytes, a
   * compiled module, an address, or a function that answers one of those. A function is asked
   * only when an app needs that tier, so a host whose page already runs ZIPP's JavaScript and
   * Python engine can offer it for the Python tiers and ship no second copy of it.
   */
  engineWasm?: Partial<Record<ZippEngineTier, ZippEngineSupplier>>;
  /**
   * Optional host-supplied `BackendTransport` (e.g. for FormLogic multi-user remote backends).
   * When provided, replaces the local in-browser Backend Worker while preserving the exact
   * frontend routing, cookie, and virtual navigation contract.
   */
  backendTransport?: BackendTransport;
  /**
   * Optional remote multi-user backend base URL (e.g. `"/api"` or `"https://host.example/app"`).
   * When provided without an explicit `backendTransport`, SoftN constructs a
   * `RemoteBackendTransport` forwarding matching backend/API/WebSocket calls to this server
   * instead of booting an in-browser backend worker.
   */
  backendUrl?: string;
  /** Optional static headers attached to every request sent through `backendUrl`. */
  backendHeaders?: Record<string, string>;
  /** Optional explicit XDB SQLite WASM module/bytes/URL supplier (overrides `runtimeUrl/engines/xdb-wasm.wasm`). */
  xdbWasm?: ZippEngineSupplier;
  /** Optional explicit XDB glue JS URL/path override. */
  xdbGlueUrl?: string;
  /** Optional JSON seed overrides keyed by database name (applied on first boot via XDB `seed_json`). */
  databaseSeeds?: Record<string, string | Record<string, unknown>>;
  /** Initial virtual URL path to load (default `'/'` for SSR/backend apps or `manifest.main` for static apps). */
  initialPath?: string;
  /** Show an isolated virtual folder & script navigation bar in the container frame (default `false`). */
  virtualNav?: boolean;
  /** Optional custom vendor ESM module map (`specifier -> ESM source or URL`). */
  vendorModules?: Record<string, string>;
  /**
   * The embedding page's own Three.js, for a host that bundles one: asked for when an app
   * first draws a 3D scene, instead of the copy in the runtime folder (`vendor/three.js`),
   * which such a host need not ship.
   */
  hostThree?: () => Promise<unknown>;
  /**
   * What happens when the app asks to save a file to the person's disk (a link with
   * `download` to a blob it made). `'ask'` (the default): a bar drawn by the container, above
   * the app, names the app and the file, and the file is saved if the person says so.
   * `'deny'`: nothing is ever saved. Either way only after a click or a key of the person's
   * in the app just before, and one file for each.
   */
  downloads?: 'ask' | 'deny';
  /**
   * For a host that asks the person itself: called in place of the container's bar, with
   * the file as the app made it. The file is saved when this answers true.
   */
  onSaveRequest?: (file: SaveRequest) => boolean | Promise<boolean>;
  /** Permission mode: `'prompt'` shows non-blocking consent bar; `'preapproved'` grants declared permissions; `'deny'` denies all. */
  permissionMode?: 'prompt' | 'preapproved' | 'deny';
  /** Override `permission.json` from host deployment configuration. */
  permissionsOverride?: ContainerPermissions;
  /**
   * What the person has already allowed, for a host that asks them itself (`permissionMode:
   * 'deny'`): in place before the app's first script runs. A grant handed over only after the
   * mount resolves comes after the page's start-up scripts, so a `fetch` on load was refused
   * for a visitor who had allowed it on every earlier visit. Not `'preapproved'`, which grants
   * whatever the archive itself asks for.
   */
  initialGrantedCapabilities?: readonly Capability[];
  /** Stable container storage identity override. */
  appId?: string;
  /**
   * The key prefix the app's kept data goes under in the embedding page's localStorage,
   * instead of `softn-v2:<appId>:`. For a host that keeps each app's data under a prefix of
   * its own and lists, moves and removes it by that prefix: the container's is then with it.
   */
  storagePrefix?: string;
  /** App-scoped storage supplied by an embedding host, including opaque-origin frames. */
  storage?: Storage;
  /** Dispatch a named action to this app's backend. The host authorizes each action. */
  backendCall?: (action: string, input: Record<string, unknown>) => Promise<unknown>;
  /**
   * Optional cross-platform hardware & device bridge (`softn:camera`, `softn:bluetooth`,
   * `softn:location`, `softn:haptics`, `softn:notifications`, `softn:device`).
   * Defaults to `createWebDeviceBridge()` in browser environments; mobile/desktop hosts
   * inject native adapters here.
   */
  deviceBridge?: ContainerDeviceBridge;
  /** Theme preference (`'light' | 'dark' | 'auto'`). */
  theme?: 'light' | 'dark' | 'auto';
  /** Execution mode: `'worker'` (default in browser) or `'inline'` (used in Node/JSDOM tests where Web Workers are unavailable). */
  isolation?: 'worker' | 'inline';
  /** Whether guest `localStorage` and `softn:db` writes persist to host `localStorage` (default `true`; set `false` for ephemeral editor previews). */
  persistStorage?: boolean;
  /** Resource limits. */
  limits?: ContainerLimits;
  /**
   * Optional on-demand bridge for SoftN's `.ui` interface language (`mode === 'legacy-ui'`).
   * Loaded only when an archive declares `.ui` pages instead of a Web Container HTML entry.
   */
  legacyUiBridge?: (
    mountTarget: HTMLElement,
    archive: {
      readonly manifest: ContainerManifest;
      readonly permissions: ContainerPermissions;
      readonly digest: string;
      names(): string[];
      readText(path: string): string | null;
      readBytes(path: string): Uint8Array | null;
    }
  ) => Promise<{ dispose(): void }>;
  /** Console callback for guest `console.*` output. */
  onConsole?: (level: 'log' | 'info' | 'warn' | 'error', text: string) => void;
  /** Title change callback (`document.title = ...`). */
  onTitleChange?: (title: string) => void;
  /** Error callback. */
  onError?: (error: Error) => void;
  /** Live startup progress callback (opening archive, loading SQLite/backend WASM, migrations, starting UI). */
  onStatus?: (status: ContainerBootStatus) => void;
  /** Open this HTML file in the archive, or the main page if the file no longer exists. */
  initialPage?: string;
  /** The HTML page that finished opening, including the first one. */
  onPageChange?: (path: string, manifest: ContainerManifest) => void;
  /** Virtual URL path updates (`'/'`, `'/about.html'`, `'/blog/post.html'`) for host URL bar sync. */
  onRouteChange?: (urlPath: string, pushHistory: boolean) => void;
  /** Per-page SEO metadata extracted from the active HTML page (`title`, `description`, `robots`, `lang`). */
  onPageMetaChange?: (meta: ContainerPageMeta) => void;
  /** Let an embedding host present a web link clicked by the user. */
  onExternalLink?: (href: string) => void;
  /** Ready callback once initial scripts + `DOMContentLoaded` complete. */
  onReady?: (info: { manifest: ContainerManifest; engineTier: ZippEngineTier; capabilitiesRequested: Capability[] }) => void;
}

/** Messages posted from Host (`<softn-app>`) to Worker (`container-worker.js`). */
export type HostToWorkerMsg =
  | {
      type: 'init';
      appId: string;
      manifest: ContainerManifest;
      seed: ShellSeed;
      scripts: ExtractedScript[];
      /** The page's scripts, for the app's document (each where it was). */
      placed?: PlacedScript[];
      textFiles: Record<string, string>;
      /** Every other file of the app, as its bytes; the Worker writes one out as base64 when a script reads it. */
      binaryFiles: Record<string, Uint8Array>;
      runtimeUrl: string;
      engineTier: ZippEngineTier;
      /** The engine to run: a compiled module or bytes; an address only for a session in the page itself. */
      engineModule?: WebAssembly.Module | Uint8Array | string;
      torchModule?: WebAssembly.Module | Uint8Array;
      vendorModules?: Record<string, string>;
      grantedCapabilities: Capability[];
      permissions: ContainerPermissions;
      initialStorage: Record<string, string>;
      initialSessionStorage?: Record<string, string>;
      initialDbRecords: Record<string, unknown[]>;
      /** What the app's IndexedDB databases were kept as: each a text, by a name of the app's side's own making. */
      initialIdb?: Record<string, string>;
      /** Whether they are kept apart from the app's localStorage (in the page's IndexedDB), held to `idbQuotaBytes` rather than counted in `storageQuotaBytes`. */
      idbApart?: boolean;
      /** Full-stack backend routing metadata (frontend worker routes matching URLs via host `BackendTransport`). */
      backendRouting?: {
        enabled: boolean;
        mode: 'api' | 'ssr';
        routes: string[];
        interceptOrigins: string[];
      };
      /** Whether frontend `softn:sqlite` host RPC is enabled (when container declares `databases`). */
      hasSqlite?: boolean;
      limits: Required<ContainerLimits>;
    }
  | {
      type: 'event';
      turnId: number;
      nodeId: number;
      eventType: string;
      props: Record<string, unknown>;
      syncChanges?: unknown[];
    }
  | {
      type: 'sync';
      changes: unknown[];
    }
  | {
      type: 'raf';
      timestamp: number;
    }
  | {
      type: 'permissions-updated';
      grantedCapabilities: Capability[];
    }
  | {
      type: 'host-reply';
      requestId: number;
      ok: boolean;
      result?: unknown;
      error?: string;
    }
  /** Live push event from a backend-routed WebSocket (`BackendTransport.openWebSocket`). */
  | { type: 'ws-event'; id: string; event: BackendWsEvent }
  /** What another tab keeps for the same app changed: a key of its localStorage, or a part of an IndexedDB database (null: removed). */
  | { type: 'storage-changed'; area: 'ls' | 'idb'; key: string; value: string | null }
  /** This tab holds an IndexedDB database it asked for (`idb-hold`): its parts that changed since, as kept now (null: removed). */
  | { type: 'idb-held'; id: number; parts: Record<string, string | null> }
  /** Parts of the app's IndexedDB another tab (or the same app elsewhere in this page) kept, together: taken in in one turn. */
  | { type: 'idb-changed'; parts: Record<string, string | null> }
  /** Whether the page kept the parts of the app's IndexedDB written in a batch (`idb-writes`): a transaction is complete only once they are. */
  | { type: 'idb-kept'; id: number; ok: boolean }
  /** The app is not on screen (`pause`) or is again (`resume`): its timers wait meanwhile. */
  | { type: 'pause' }
  | { type: 'resume' }
  | {
      type: 'dispose';
    };

/** Messages posted from Worker (`container-worker.js`) to Host (`<softn-app>`). */
export type WorkerToHostMsg =
  | { type: 'ready' }
  | { type: 'ops'; ops: ShellOp[]; turnId?: number; eventBits?: number; wantsRaf?: boolean; rafReply?: boolean }
  /** Zero-copy GPU WebGL/WebGL2 frame rendered on an OffscreenCanvas in the container Worker. */
  | { type: 'webgl-frame'; canvasId: number; bitmap: ImageBitmap; width: number; height: number }
  | { type: 'session-route'; urlPath: string }
  | { type: 'session-storage-write'; op: 'set' | 'remove' | 'clear'; key?: string; value?: string }
  | { type: 'console'; level: 'log' | 'info' | 'warn' | 'error'; text: string }
  | { type: 'storage-write'; op: 'set' | 'remove' | 'clear'; key?: string; value?: string }
  | { type: 'db-write'; collection: string; records: unknown[] }
  /**
   * Parts of the app's IndexedDB databases to keep (each its text), or to let go of (null):
   * all a turn wrote, kept together (a transaction is kept whole or not at all).
   */
  | { type: 'idb-writes'; id: number; parts: Record<string, string | null> }
  /**
   * The app's side is to write to a database (a transaction that writes, an upgrade, a
   * deletion): this tab is to hold it, and be told what other tabs kept in it, first. Let go
   * of (`idb-release`) once nothing here writes to it; what was written meanwhile is kept then.
   */
  | { type: 'idb-hold'; id: number; name: string }
  | { type: 'idb-release'; name: string }
  | { type: 'host-request'; requestId: number; kind: string; payload: Record<string, unknown> }
  | {
      type: 'error';
      message: string;
      phase: string;
      fatal: boolean;
      file?: string;
      line?: number;
      column?: number;
      stack?: string;
      snippet?: string;
    };

/** Structured error emitted by `@softn/container` with mapped source file, line, column, and code frame. */
export class SoftNContainerError extends Error {
  readonly phase: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly snippet?: string;
  readonly guestStack?: string;

  constructor(
    message: string,
    details: { phase: string; file?: string; line?: number; column?: number; snippet?: string; stack?: string },
  ) {
    super(message);
    this.name = 'SoftNContainerError';
    this.phase = details.phase;
    this.file = details.file;
    this.line = details.line;
    this.column = details.column;
    this.snippet = details.snippet;
    this.guestStack = details.stack;
  }
}
