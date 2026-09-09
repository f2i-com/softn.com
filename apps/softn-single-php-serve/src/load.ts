import {
  processBundle,
  loadXDBData,
  extractPermissions,
  type BundleManifest,
} from '../../softn-web/src/lib/bundleProcessor';
import { digest, fetchBytes, localUrl, parsePermissions } from '../../softn-single/src/config';
import type { RunnableApplication } from '../../softn-single/src/SingleApp';
import { createServedAssetResolver } from './assets';

/**
 * What `index.php?source` answers: the deployment's settings, the manifest
 * with only the fields the runtime reads, the text entries the composer and
 * the import resolver need, and the names and sizes of every other entry,
 * which are fetched one by one when the app renders them.
 */
export interface SourcePack {
  version: 1;
  id: string;
  title: string;
  theme: 'light' | 'dark';
  loadingText: string;
  permissionMode: 'prompt' | 'preapproved';
  /** SHA-256 of the archive the server opened, hex. */
  digest: string;
  manifest: BundleManifest;
  /** The operator's sidecar declaration, when one is configured. */
  declared: unknown;
  text: Record<string, string>;
  entries: Record<string, number>;
}

const MAX_PACK_BYTES = 32 * 1024 * 1024;

function entryName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 1024 &&
    !name.includes('\0') &&
    !name.includes('\\') &&
    !/^[a-zA-Z]:/.test(name) &&
    name.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

export function parsePack(input: unknown): SourcePack {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw Error('Invalid source pack');
  const p = input as Record<string, unknown>;
  const keys = [
    'version',
    'id',
    'title',
    'theme',
    'loadingText',
    'permissionMode',
    'digest',
    'manifest',
    'declared',
    'text',
    'entries',
  ];
  if (Object.keys(p).some((k) => !keys.includes(k)) || p.version !== 1)
    throw Error('Invalid source pack');
  if (typeof p.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(p.id))
    throw Error('Invalid application id');
  if (typeof p.title !== 'string' || !p.title.trim() || p.title.length > 120)
    throw Error('Invalid application title');
  if (p.theme !== 'light' && p.theme !== 'dark') throw Error('Invalid theme');
  if (typeof p.loadingText !== 'string' || p.loadingText.length > 160)
    throw Error('Invalid loading text');
  if (p.permissionMode !== 'prompt' && p.permissionMode !== 'preapproved')
    throw Error('Invalid permission mode');
  if (typeof p.digest !== 'string' || !/^[a-f0-9]{64}$/.test(p.digest))
    throw Error('Invalid digest');
  const manifest = p.manifest as BundleManifest | null;
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    typeof manifest.name !== 'string' ||
    typeof manifest.main !== 'string' ||
    !manifest.files ||
    typeof manifest.files !== 'object' ||
    Array.isArray(manifest.files)
  )
    throw Error('Invalid application manifest');
  if (!p.text || typeof p.text !== 'object' || Array.isArray(p.text))
    throw Error('Invalid source pack');
  if (!p.entries || typeof p.entries !== 'object' || Array.isArray(p.entries))
    throw Error('Invalid source pack');
  const text = p.text as Record<string, unknown>;
  const entries = p.entries as Record<string, unknown>;
  for (const [name, value] of Object.entries(text))
    if (!entryName(name) || typeof value !== 'string') throw Error('Invalid source pack');
  for (const [name, size] of Object.entries(entries))
    if (!entryName(name) || name in text || !Number.isInteger(size) || (size as number) < 0)
      throw Error('Invalid source pack');
  return {
    version: 1,
    id: p.id,
    title: p.title,
    theme: p.theme,
    loadingText: p.loadingText,
    permissionMode: p.permissionMode,
    digest: p.digest,
    manifest,
    declared: p.declared ?? null,
    text: text as Record<string, string>,
    entries: entries as Record<string, number>,
  };
}

/**
 * Load the app the endpoint serves. The steps are those of
 * apps/softn-single/src/load.ts with the archive replaced by the pack: the
 * same composer, the same XDB seeding, the same permission precedence
 * (operator sidecar, then the bundle's permission.json, then its legacy
 * manifest declaration, then nothing) and the same consent key shape, so a
 * visitor's grant is scoped to this endpoint, these exact bundle bytes and
 * this declaration.
 */
export async function loadServedApplication(
  endpoint: string,
  base: string,
  signal: AbortSignal
): Promise<RunnableApplication & { pack: SourcePack }> {
  const url = new URL(localUrl(endpoint, base));
  if (url.search || url.hash) throw Error('Invalid endpoint');
  const bytes = await fetchBytes(url.href + '?source', signal, MAX_PACK_BYTES);
  const pack = parsePack(JSON.parse(new TextDecoder().decode(bytes)));
  const textFiles = new Map(Object.entries(pack.text));
  const raw = pack.manifest;
  if (!textFiles.has(raw.main)) throw Error('Invalid application manifest');

  const declared =
    pack.declared !== null
      ? parsePermissions(pack.declared)
      : textFiles.has('permission.json')
        ? parsePermissions(JSON.parse(textFiles.get('permission.json')!))
        : parsePermissions(extractPermissions(textFiles, raw) ?? { permissions: {} });

  const source = processBundle(textFiles, raw);
  const appId = 'served:' + url.pathname + ':' + pack.id;
  await loadXDBData(textFiles, raw, appId);
  signal.throwIfAborted();
  const grantKey =
    'single-grant:' +
    (await digest(new TextEncoder().encode(url.href + pack.digest + JSON.stringify(declared))));
  signal.throwIfAborted();
  const execution: 'worker' | 'main' = raw.config?.execution === 'worker' ? 'worker' : 'main';
  const assets = createServedAssetResolver(
    url.pathname,
    new Set(Object.keys(pack.entries)),
    textFiles
  );
  return {
    config: {
      title: pack.title,
      theme: pack.theme,
      loadingText: pack.loadingText,
      permissionMode: pack.permissionMode,
    },
    declared,
    grantKey,
    appId,
    textFiles,
    execution,
    ...source,
    assets,
    pack,
  };
}
