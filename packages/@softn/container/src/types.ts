import type { Capability } from '@softn/bundle-format/capabilities';

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
  | 'python-torch';

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
    [key: string]: { enabled?: boolean } | undefined;
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
}

/** Compact 2D `<canvas>` command tuple replayed on the host `<canvas>`. */
export type Canvas2DCmd =
  | ['prop', string, string | number]
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
  | ['x', number, string]
  | ['m', number]
  | ['a', number, string, string | null]
  | ['c', number, number[]]
  | ['p', number, string, unknown]
  | ['l', string]
  | ['t', string]
  | ['n', string]
  /** A blob the script made an address for: its id, its type, its bytes in base64; and one let go. */
  | ['blob', string, string, string]
  | ['unblob', string]
  /** An image that is not on the page, for the host to load and say when it has: a token to answer by, and the address. */
  | ['img', string, string]
  /** An animation of an element (`element.animate`): its key, the element, its keyframes and its timing; and what the script then asks of it. */
  | ['anim', string, number, unknown, unknown]
  | ['anim-ctl', string, string]
  | ['k2d', number, number, number, Canvas2DCmd[]]
  | ['3d', number, ThreeSceneOp[]];

/** Measured bounding rect tuple: [id, x, y, width, height], and how wide and tall what it holds is (scrollWidth, scrollHeight). */
export type MeasuredBoxTuple = [number, number, number, number, number, number?, number?];

/** Resource & execution limits applied to each container Worker. */
export interface ContainerLimits {
  /** Max VM bytecode instructions per turn (default 100,000,000). */
  instructionsPerTurn?: number;
  /** Wall-clock timeout in ms before terminating a hung Worker turn (default 15,000). */
  turnTimeoutMs?: number;
  /** What the app may keep, its localStorage and its records together, in bytes (default 5 MB: half of what a browser gives the page). */
  storageQuotaBytes?: number;
}

/** A ZIPP engine as a host can hand it over: bytes, a compiled module, or an address to fetch. */
export type ZippEngineSource = BufferSource | WebAssembly.Module | string;

/** An engine, or a function that answers one when its tier is first needed. */
export type ZippEngineSupplier = ZippEngineSource | (() => ZippEngineSource | Promise<ZippEngineSource>);

/** Configuration for mounting a SoftN v2 container. */
export interface SoftNContainerOptions {
  /** `.softn` ZIP bytes, URL to a `.softn` archive, or unpacked file map. */
  source: Uint8Array | ArrayBuffer | string | Record<string, string | Uint8Array>;
  /** Base URL where `/runtime/` assets (`engines/`, `vendor/`, `ui/`, `compat/`) are served. */
  runtimeUrl?: string;
  /**
   * A tier's engine from the host instead of from `runtimeUrl`'s `engines/` folder: its bytes, a
   * compiled module, an address, or a function that answers one of those. A function is asked
   * only when an app needs that tier, so a host whose page already runs ZIPP's JavaScript and
   * Python engine can offer it for the Python tiers and ship no second copy of it.
   */
  engineWasm?: Partial<Record<ZippEngineTier, ZippEngineSupplier>>;
  /** Optional custom vendor ESM module map (`specifier -> ESM source or URL`). */
  vendorModules?: Record<string, string>;
  /**
   * The embedding page's own Three.js, for a host that bundles one: asked for when an app
   * first draws a 3D scene, instead of the copy in the runtime folder (`vendor/three.js`),
   * which such a host need not ship.
   */
  hostThree?: () => Promise<unknown>;
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
  /** Theme preference (`'light' | 'dark' | 'auto'`). */
  theme?: 'light' | 'dark' | 'auto';
  /** Execution mode: `'worker'` (default in browser) or `'inline'` (used in Node/JSDOM tests where Web Workers are unavailable). */
  isolation?: 'worker' | 'inline';
  /** Whether guest `localStorage` and `softn:db` writes persist to host `localStorage` (default `true`; set `false` for ephemeral editor previews). */
  persistStorage?: boolean;
  /** Resource limits. */
  limits?: ContainerLimits;
  /** Console callback for guest `console.*` output. */
  onConsole?: (level: 'log' | 'info' | 'warn' | 'error', text: string) => void;
  /** Title change callback (`document.title = ...`). */
  onTitleChange?: (title: string) => void;
  /** Error callback. */
  onError?: (error: Error) => void;
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
      initialDbRecords: Record<string, unknown[]>;
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
  /** The app is not on screen (`pause`) or is again (`resume`): its timers wait meanwhile. */
  | { type: 'pause' }
  | { type: 'resume' }
  | {
      type: 'dispose';
    };

/** Messages posted from Worker (`container-worker.js`) to Host (`<softn-app>`). */
export type WorkerToHostMsg =
  | { type: 'ready' }
  | { type: 'ops'; ops: ShellOp[]; turnId?: number; eventBits?: number; wantsRaf?: boolean }
  | { type: 'console'; level: 'log' | 'info' | 'warn' | 'error'; text: string }
  | { type: 'storage-write'; op: 'set' | 'remove' | 'clear'; key?: string; value?: string }
  | { type: 'db-write'; collection: string; records: unknown[] }
  | { type: 'host-request'; requestId: number; kind: string; payload: Record<string, unknown> }
  | { type: 'error'; message: string; phase: string; fatal: boolean };
