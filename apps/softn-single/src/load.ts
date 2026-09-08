import {
  readZip,
  processBundle,
  loadXDBData,
  createAssetResolver,
  extractPermissions,
  extractIconDataUrl,
  firstScreenAssets,
  type BundleManifest,
} from '../../softn-web/src/lib/bundleProcessor';
import { warmFirstScreen } from '../../softn-web/src/lib/zipWarmup';
import { digest, fetchBytes, parseConfig, parsePermissions } from './config';
// Startup phase boundaries on the performance timeline, `softn:<phase>:start`
// and `:end`, the names every host writes so one baseline covers them all. A
// phase that throws leaves its start mark alone, which says where it stopped.
function mark(name: string) {
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function')
    performance.mark(name);
}
export async function loadApplication(configUrl: string, signal: AbortSignal) {
  const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  const config = parseConfig(decode(await fetchBytes(configUrl, signal, 16384)), configUrl);
  mark('softn:bundle-fetch:start');
  const bytes = await fetchBytes(config.bundle, signal, 32 * 1024 * 1024);
  mark('softn:bundle-fetch:end');
  mark('softn:digest:start');
  const hash = await digest(bytes);
  mark('softn:digest:end');
  if (config.sha256 && hash !== config.sha256) throw Error('Application integrity check failed');
  // Indexes the archive and reads its text; binaries are read when an asset()
  // asks for them, or by the warm-up below.
  mark('softn:zip:start');
  const { textFiles, binaryFiles, archive } = readZip(bytes);
  mark('softn:zip:end');
  const raw = JSON.parse(textFiles.get('manifest.json') ?? 'null') as BundleManifest | null;
  if (
    !raw ||
    typeof raw.name !== 'string' ||
    typeof raw.main !== 'string' ||
    !raw.files ||
    !textFiles.has(raw.main)
  )
    throw Error('Invalid application manifest');
  const declared = config.permissions
    ? parsePermissions(decode(await fetchBytes(config.permissions, signal, 65536)))
    : textFiles.has('permission.json')
      ? parsePermissions(JSON.parse(textFiles.get('permission.json')!))
      : parsePermissions(extractPermissions(textFiles, raw) ?? { permissions: {} });
  mark('softn:compose:start');
  const source = processBundle(textFiles, raw);
  mark('softn:compose:end');
  // Identity comes from this origin's deployment config, not an untrusted manifest name.
  const appId = 'single:' + new URL(configUrl).pathname + ':' + config.id;
  mark('softn:xdb-seed:start');
  await loadXDBData(textFiles, raw, appId);
  mark('softn:xdb-seed:end');
  signal.throwIfAborted();
  // Consent is build- and policy-specific, including host restrictions, not just capability names.
  const grantKey =
    'single-grant:' +
    (await digest(new TextEncoder().encode(configUrl + hash + JSON.stringify(declared))));
  signal.throwIfAborted();
  // The launcher forwards `config.execution` to the renderer; this host did not,
  // so the same bundle ran its script on the main thread here and in a worker
  // there. Read the way inspectBundle reads it (@softn/core/src/bundle/inspect.ts,
  // not exported on its own): only the literal 'worker' asks for a worker, and
  // anything else, a misspelling included, is main. Whether the script can in
  // fact leave the main thread is still the renderer's decision.
  const execution: 'worker' | 'main' = raw.config?.execution === 'worker' ? 'worker' : 'main';
  // The declared size bounds the favicon before its bytes exist: an oversize
  // icon is never inflated, where it used to be inflated and then refused.
  const icon =
    typeof raw.icon === 'string' && (binaryFiles.declaredSize(raw.icon) ?? Infinity) <= 256 * 1024
      ? extractIconDataUrl(binaryFiles, raw)
      : undefined;
  const assets = createAssetResolver(binaryFiles, textFiles);
  // Not awaited, as in the launcher: the app renders while a worker inflates
  // what its source names by literal, then the manifest's asset list.
  // `assets.dispose()` releases the archive, which ends a warm-up still in
  // flight.
  const warmup = warmFirstScreen(
    archive,
    bytes,
    firstScreenAssets(source.source, raw, binaryFiles)
  );
  return {
    config,
    declared,
    grantKey,
    appId,
    textFiles,
    execution,
    icon,
    ...source,
    assets,
    warmup,
  };
}
export type LoadedApplication = Awaited<ReturnType<typeof loadApplication>>;
