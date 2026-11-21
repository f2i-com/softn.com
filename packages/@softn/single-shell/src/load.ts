import {
  readZip,
  createAssetResolver,
  extractIconDataUrl,
  firstScreenAssets,
  type BundleManifest,
} from '@softn/runtime-shell/bundleProcessor';
import { warmFirstScreen } from '@softn/runtime-shell/zipWarmup';
import { unwrapContainerZipEntries } from '@softn/runtime-shell/containerBundle';
import { preloadRememberedFirstDraw, readManifest } from '@softn/core';
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
  const appId = 'single:' + new URL(configUrl).pathname + ':' + config.id;
  // What this app's first screen waited for last time, started now, while
  // the bundle is on its way rather than after it has been read.
  preloadRememberedFirstDraw(appId);
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
    grantScope: configUrl + hash,
    signal,
  });
  const icon =
    typeof raw.icon === 'string' && (binaryFiles.declaredSize(raw.icon) ?? Infinity) <= 256 * 1024
      ? extractIconDataUrl(binaryFiles, raw)
      : undefined;
  const assets = createAssetResolver(binaryFiles, textFiles);
  const warmup = app.webContainer
    ? { done: Promise.resolve(), abort: () => {} }
    : warmFirstScreen(archive, bytes, firstScreenAssets(app.source, raw, binaryFiles));
  return { config, ...app, bundleData: bytes, icon, assets, warmup };
}
export type LoadedApplication = Awaited<ReturnType<typeof loadApplication>>;
