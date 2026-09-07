import {
  readZip,
  processBundle,
  loadXDBData,
  createAssetResolver,
  extractPermissions,
  type BundleManifest,
} from '../../softn-web/src/lib/bundleProcessor';
import { digest, fetchBytes, parseConfig, parsePermissions } from './config';
export async function loadApplication(configUrl: string, signal: AbortSignal) {
  const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  const config = parseConfig(decode(await fetchBytes(configUrl, signal, 16384)), configUrl);
  const bytes = await fetchBytes(config.bundle, signal, 32 * 1024 * 1024);
  const hash = await digest(bytes);
  if (config.sha256 && hash !== config.sha256) throw Error('Application integrity check failed');
  const { textFiles, binaryFiles } = readZip(bytes);
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
  const source = processBundle(textFiles, raw);
  // Identity comes from this origin's deployment config, not an untrusted manifest name.
  const appId = 'single:' + new URL(configUrl).pathname + ':' + config.id;
  await loadXDBData(textFiles, raw, appId);
  signal.throwIfAborted();
  // Consent is build- and policy-specific, including host restrictions, not just capability names.
  const grantKey =
    'single-grant:' +
    (await digest(new TextEncoder().encode(configUrl + hash + JSON.stringify(declared))));
  signal.throwIfAborted();
  return {
    config,
    declared,
    grantKey,
    appId,
    textFiles,
    ...source,
    assets: createAssetResolver(binaryFiles, textFiles),
  };
}
export type LoadedApplication = Awaited<ReturnType<typeof loadApplication>>;
