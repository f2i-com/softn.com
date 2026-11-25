/**
 * The steps every single-app host takes once it holds a bundle's text: read
 * the manifest, settle the permission declaration, compose the source, seed
 * XDB and key the visitor's grant. The archive-served shell (`load.ts`) and
 * the PHP-served variant (apps/softn-single-private) differ only in where
 * the text and the binary entries come from, so this is where they agree —
 * a bundle that opens on one host opens on the other, with the same grant
 * scope and the same refusal message.
 */
import { ManifestError } from '@softn/core/web-host';
import type { PermissionConfig } from '@softn/core';
import { extractPermissions, type BundleManifest } from '@softn/runtime-shell/bundleFiles';
import type { processBundle } from '@softn/runtime-shell/bundleProcessor';
import {
  WEB_CONTAINER_SOURCE_SENTINEL,
  detectWebContainer,
} from '@softn/runtime-shell/containerBundle';
import { containerRuntimeUrl } from '@softn/runtime-shell/containerHost';
import { digest, parsePermissions } from './config';
import { preloadUiSurface } from './uiSurfaceLoader';

/**
 * Patterns requiring the full ZIPP JS+Python engine (`zipp_wasm_bg.wasm`, 7.25 MB) rather
 * than the ABI-compatible `zipp-javascript-lite.wasm` (2.77 MB / 779 KB Brotli).
 */
const NEEDS_FULL_JS_ENGINE =
  /\b(?:Intl|Temporal)\b|\.(?:toLocale(?:String|DateString|TimeString|UpperCase|LowerCase)|localeCompare)\b/;

let classicTierConfigured = false;

function tryConfigureClassicLiteEngine(
  source: ReturnType<typeof processBundle>,
  textFiles: Map<string, string>,
  registerWasmSource: (source: Promise<WebAssembly.Module | null>) => void
): void {
  if (classicTierConfigured) return;
  if (typeof window === 'undefined' || typeof fetch !== 'function' || typeof WebAssembly !== 'object') return;
  if ((import.meta as unknown as { env?: { MODE?: string } }).env?.MODE === 'test') return;
  if (source.languages.includes('python')) return;
  if (NEEDS_FULL_JS_ENGINE.test(source.source)) return;
  for (const [path, content] of textFiles) {
    if (/\.py$/i.test(path)) return;
    if (/\.(?:logic|ui|m?js|jsx|ts|tsx)$/i.test(path) && NEEDS_FULL_JS_ENGINE.test(content)) return;
  }
  const liteUrl = `${containerRuntimeUrl()}engines/zipp-javascript-lite.wasm`;
  classicTierConfigured = true;
  try {
    registerWasmSource(
      fetch(liteUrl)
        .then(async (resp): Promise<WebAssembly.Module | null> => {
          if (!resp.ok) return null;
          const ct = (resp.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
          if (ct === 'application/wasm' && typeof WebAssembly.compileStreaming === 'function') {
            try {
              return await WebAssembly.compileStreaming(resp);
            } catch {
              const retry = await fetch(liteUrl);
              if (!retry.ok) return null;
              return await WebAssembly.compile(await retry.arrayBuffer());
            }
          }
          return await WebAssembly.compile(await resp.arrayBuffer());
        })
        .catch(() => null)
    );
  } catch {
    // ZIPP initialization already started in this realm; keep the active engine.
  }
}

/**
 * Startup phase boundaries on the performance timeline, `softn:<phase>:start`
 * and `:end`, the names every host writes so one baseline covers them all. A
 * phase that throws leaves its start mark alone, which says where it stopped.
 */
export function mark(name: string) {
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function')
    performance.mark(name);
}

export interface AssembleInput {
  textFiles: Map<string, string>;
  /** The manifest as the host reads it; a `ManifestError` becomes the shell's own message. */
  readManifest: () => BundleManifest;
  /**
   * The operator's sidecar declaration, when the deployment has one: a
   * function so the host fetches it only after the manifest has been read,
   * and yields the parsed JSON whatever it is — the shell refuses what is
   * not a declaration.
   */
  sidecar?: () => Promise<unknown>;
  /** The app's identity on this host, which its records are keyed by. */
  appId: string;
  /** What the grant is scoped to besides the declaration: the page and the exact bundle bytes. */
  grantScope: string;
  /** Parsed manifest when the host served it out-of-band (e.g. `softn-single-private`). */
  manifestHint?: Record<string, unknown>;
  signal: AbortSignal;
}

export type AssembledApplication = ReturnType<typeof processBundle> & {
  /** The manifest, for what the host reads after this: the icon, the first-screen assets. */
  raw: BundleManifest;
  declared: PermissionConfig;
  grantKey: string;
  appId: string;
  textFiles: Map<string, string>;
  execution: 'worker' | 'main';
  /**
   * The side the project declares: the manifest's `config.theme.mode`, as
   * the manifest has it. Read here so the archive-served and the PHP-served
   * host hand the theme rule the same word; which words decide anything is
   * the rule's (@softn/components, theme/app-theme.ts), not the shell's.
   */
  themeMode: unknown;
  /** True when the bundle runs inside `@softn/container` (`<softn-app>`). */
  webContainer?: boolean;
};

export async function assembleApplication(input: AssembleInput): Promise<AssembledApplication> {
  const { textFiles, sidecar, appId, grantScope, manifestHint, signal } = input;
  const checkFiles =
    manifestHint && !textFiles.has('manifest.json')
      ? new Map([...textFiles, ['manifest.json', JSON.stringify(manifestHint)]])
      : textFiles;
  const containerCheck = detectWebContainer(checkFiles);
  let raw: BundleManifest;
  if (containerCheck.inferredManifest) {
    raw = containerCheck.inferredManifest;
  } else {
    try {
      raw = input.readManifest();
    } catch (e) {
      throw Error(`Invalid application manifest: ${e instanceof ManifestError ? e.message : String(e)}`);
    }
  }
  const declared = sidecar
    ? parsePermissions(await sidecar())
    : textFiles.has('permission.json')
      ? parsePermissions(JSON.parse(textFiles.get('permission.json')!))
      : parsePermissions(extractPermissions(textFiles, raw) ?? { permissions: {} });
  let source: ReturnType<typeof processBundle>;
  if (containerCheck.isWebContainer) {
    // Kick off container chunk download immediately so it overlaps with grantKey digest & React render.
    if (typeof window !== 'undefined' && (import.meta as unknown as { env?: { MODE?: string } }).env?.MODE !== 'test') {
      void import('@softn/container/mount').catch(() => undefined);
    }
    if (manifestHint && !textFiles.has('manifest.json')) {
      textFiles.set('manifest.json', JSON.stringify(manifestHint));
    }
    source = {
      source: WEB_CONTAINER_SOURCE_SENTINEL,
      logicBasePath: undefined,
      preIncludedLogicPaths: [],
      languages: [],
    };
  } else {
    const classic = await preloadUiSurface();
    signal.throwIfAborted();
    classic.preloadRememberedFirstDraw(appId);
    mark('softn:compose:start');
    source = classic.processBundle(textFiles, raw);
    mark('softn:compose:end');
    tryConfigureClassicLiteEngine(source, textFiles, classic.awaitZippWasmSource);
    mark('softn:xdb-seed:start');
    await classic.loadXDBData(textFiles, raw, appId);
    mark('softn:xdb-seed:end');
  }
  signal.throwIfAborted();
  const grantKey =
    'single-grant:' + (await digest(new TextEncoder().encode(grantScope + JSON.stringify(declared))));
  signal.throwIfAborted();
  const execution: 'worker' | 'main' =
    containerCheck.isWebContainer || raw.config?.execution === 'worker' ? 'worker' : 'main';
  const theme: unknown = (raw.config as { theme?: unknown } | null | undefined)?.theme;
  const themeMode: unknown = theme && typeof theme === 'object' ? (theme as { mode?: unknown }).mode : undefined;
  return {
    raw,
    declared,
    grantKey,
    appId,
    textFiles,
    execution,
    themeMode,
    ...(containerCheck.isWebContainer ? { webContainer: true } : {}),
    ...source,
  };
}
