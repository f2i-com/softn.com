import {
  readZip,
  createAssetResolver,
  extractIconDataUrl,
  firstScreenAssets,
  type BundleManifest,
} from '@softn/runtime-shell/bundleFiles';
import type { FirstScreenWarmup } from '@softn/runtime-shell/zipWarmup';
import { unwrapContainerZipEntries } from '@softn/runtime-shell/containerBundle';
import { readManifest } from '@softn/core/web-host';
import { assembleApplication, mark } from './assemble';
import { digest, fetchBytes, parseConfig } from './config';
/**
 * Where the configuration comes from. A standalone deployment reads the
 * `runtime.config.json` beside its entry. A directory serving this shell for
 * one of its apps writes the configuration into the page instead — one round
 * trip fewer before the bundle is asked for — and `configUrl` is then the
 * page's own address, which the bundle and endpoint locations resolve against
 * and which the grant and the local records are keyed by.
 */
export interface ConfigSource {
  configUrl: string;
  /** The page's inline configuration, as the JSON text it was written as. */
  inline?: string;
}
/** `progress` is told whenever part of a download arrives (see stall.ts). */
export async function loadApplication(from: string | ConfigSource, signal: AbortSignal, progress?: () => void) {
  const { configUrl, inline } = typeof from === 'string' ? { configUrl: from } : from;
  const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  const config = parseConfig(
    inline !== undefined ? (JSON.parse(inline) as unknown) : decode(await fetchBytes(configUrl, signal, 16384, 'no-store', progress)),
    configUrl
  );
  // Identity comes from this origin's deployment config, not an untrusted manifest name.
  // Multi-page hosted apps share one appId & grant scope across every sub-page under `basePath`.
  const identityPath = config.basePath ?? new URL(configUrl).pathname;
  const grantOriginUrl = config.basePath ? new URL(config.basePath, configUrl).href : configUrl;
  const appId = 'single:' + identityPath + ':' + config.id;
  mark('softn:bundle-fetch:start');
  // An inline configuration names a version-addressed bundle with its digest
  // pinned, so the browser's cache may answer; see fetchBytes.
  const bytes = await fetchBytes(config.bundle, signal, 32 * 1024 * 1024, inline !== undefined ? 'default' : 'no-store', progress, {
    id: 'bundle:' + config.bundle,
    name: config.title,
  });
  mark('softn:bundle-fetch:end');
  mark('softn:digest:start');
  const hash = await digest(bytes);
  mark('softn:digest:end');
  if (config.sha256 && hash !== config.sha256) throw Error('Application integrity check failed');
  // Indexes the archive and reads its text; binaries are read when an asset()
  // asks for them, or by the warm-up below.
  mark('softn:zip:start');
  const rawZip = readZip(bytes);
  mark('softn:zip:end');
  const { archive } = rawZip;
  const { textFiles, binaryFiles } = unwrapContainerZipEntries(rawZip.textFiles, rawZip.binaryFiles);
  const sidecar = config.permissions;
  const { raw, ...app } = await assembleApplication({
    textFiles,
    readManifest: () => {
      let feRoot = '';
      try {
        const rawManifest = JSON.parse(textFiles.get('manifest.json') ?? '{}') as Record<string, unknown>;
        if (typeof rawManifest.frontendRoot === 'string') {
          feRoot = rawManifest.frontendRoot.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        }
      } catch {
        // Invalid JSON surfaces through readManifest.
      }
      return readManifest<BundleManifest>(textFiles, {
        has: (path) =>
          textFiles.has(path) ||
          binaryFiles.has(path) ||
          (feRoot !== '' &&
            (textFiles.has(`${feRoot}/${path.replace(/^\/+/, '')}`) ||
              binaryFiles.has(`${feRoot}/${path.replace(/^\/+/, '')}`))),
      });
    },
    sidecar: sidecar ? async () => decode(await fetchBytes(sidecar, signal, 65536, 'no-store', progress)) : undefined,
    appId,
    grantScope: grantOriginUrl + hash,
    signal,
  });
  const icon =
    typeof raw.icon === 'string' && (binaryFiles.declaredSize(raw.icon) ?? Infinity) <= 256 * 1024
      ? extractIconDataUrl(binaryFiles, raw)
      : undefined;
  const assets = createAssetResolver(binaryFiles, textFiles);
  let warmup: FirstScreenWarmup;
  if (app.webContainer) {
    warmup = { done: Promise.resolve(), abort: () => {} };
  } else {
    const names = firstScreenAssets(app.source, raw, binaryFiles);
    if (names.length === 0) {
      warmup = { done: Promise.resolve(), abort: () => {} };
    } else {
      let aborted = false;
      let inner: FirstScreenWarmup | null = null;
      const done = import('@softn/runtime-shell/zipWarmup').then(({ warmFirstScreen }) => {
        if (aborted || archive.released) return;
        inner = warmFirstScreen(archive, bytes, names);
        return inner.done;
      });
      warmup = {
        done,
        abort: () => {
          aborted = true;
          inner?.abort();
        },
      };
    }
  }
  return { config, ...app, bundleData: bytes, bundleDigest: hash, icon, assets, warmup };
}
export type LoadedApplication = Awaited<ReturnType<typeof loadApplication>>;
