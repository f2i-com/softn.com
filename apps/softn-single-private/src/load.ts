import { normalizeManifest } from '@softn/core/web-host';
import { assembleApplication } from '@softn/single-shell/assemble';
import { fetchBytes, localUrl } from '@softn/single-shell/config';
import type { BundleManifest, RunnableApplication } from '@softn/single-shell';
import { createServedAssetResolver, entryUrl } from './assets';

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
  /** Optional same-origin remote backend URL for multi-user v2 container deployments. */
  backendUrl?: string;
}

const MAX_PACK_BYTES = 32 * 1024 * 1024;
/** The most a web container's other files may come to together, fetched into the page. */
const MAX_CONTAINER_BYTES = 128 * 1024 * 1024;
/** How many of them are asked for at a time. */
const ENTRIES_AT_ONCE = 6;

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
    'backendUrl',
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
  // Shape only; the read that decides whether it can run (`files` optional,
  // entry present) is core's normalizeManifest, once the text is known.
  const manifest = p.manifest as BundleManifest | null;
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    typeof manifest.name !== 'string' ||
    typeof manifest.main !== 'string'
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
  if (
    p.backendUrl !== undefined &&
    p.backendUrl !== null &&
    (typeof p.backendUrl !== 'string' || !p.backendUrl.trim() || p.backendUrl.length > 512)
  )
    throw Error('Invalid backendUrl');
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
    ...(typeof p.backendUrl === 'string' ? { backendUrl: p.backendUrl } : {}),
  };
}

/**
 * Load the app the endpoint serves. The steps are those of the shell's
 * archive loader with the archive replaced by the pack — the same
 * `assembleApplication`: composer, XDB seeding, permission precedence
 * (operator sidecar, then the bundle's permission.json, then its legacy
 * manifest declaration, then nothing) and consent key shape, so a visitor's
 * grant is scoped to this endpoint, these exact bundle bytes and this
 * declaration.
 */
export async function loadServedApplication(
  endpoint: string,
  base: string,
  signal: AbortSignal,
  // Told whenever part of the pack arrives (see the shell's stall.ts).
  progress?: () => void
): Promise<RunnableApplication & { pack: SourcePack }> {
  const url = new URL(localUrl(endpoint, base));
  if (url.search || url.hash) throw Error('Invalid endpoint');
  const bytes = await fetchBytes(url.href + '?source', signal, MAX_PACK_BYTES, 'no-store', progress);
  const pack = parsePack(JSON.parse(new TextDecoder().decode(bytes)));
  const backendUrl = pack.backendUrl !== undefined ? localUrl(pack.backendUrl, base) : undefined;
  const textFiles = new Map(Object.entries(pack.text));
  const appId = 'served:' + url.pathname + ':' + pack.id;
  const { raw: _manifest, ...app } = await assembleApplication({
    textFiles,
    // Shape was checked in parsePack; this is the read that decides whether
    // it can run, the same one the archive loader makes.
    readManifest: () => {
      const feRoot =
        typeof (pack.manifest as unknown as Record<string, unknown>).frontendRoot === 'string'
          ? String((pack.manifest as unknown as Record<string, unknown>).frontendRoot)
              .replace(/\\/g, '/')
              .replace(/^\/+|\/+$/g, '')
          : '';
      return normalizeManifest<BundleManifest>(
        pack.manifest,
        (path) => textFiles.has(path) || (feRoot !== '' && textFiles.has(`${feRoot}/${path.replace(/^\/+/, '')}`))
      );
    },
    sidecar: pack.declared !== null ? () => Promise.resolve(pack.declared) : undefined,
    appId,
    grantScope: url.href + pack.digest,
    manifestHint: pack.manifest as unknown as Record<string, unknown>,
    signal,
  });
  const assets = createServedAssetResolver(
    url.pathname,
    new Set(Object.keys(pack.entries)),
    textFiles
  );
  // A web container runs from its files, all of them. The pack carries the text; every
  // other entry is fetched here, a few at a time, and the manifest is put back among them
  // (the pack carries it apart). The container used to be handed the text alone, so an
  // app's images, fonts and wasm were not there.
  let containerFiles: Record<string, string | Uint8Array> | undefined;
  if (app.webContainer) {
    containerFiles = { ...pack.text, 'manifest.json': JSON.stringify(pack.manifest) };
    const names = Object.keys(pack.entries);
    const total = names.reduce((sum, name) => sum + pack.entries[name], 0);
    if (total > MAX_CONTAINER_BYTES) throw Error('This app’s files are larger than this host opens in the browser.');
    for (let at = 0; at < names.length; at += ENTRIES_AT_ONCE) {
      const batch = names.slice(at, at + ENTRIES_AT_ONCE);
      const loaded = await Promise.all(
        batch.map((name) => fetchBytes(new URL(entryUrl(url.pathname, name), url).href, signal, pack.entries[name], 'no-store', progress))
      );
      batch.forEach((name, i) => {
        containerFiles![name] = loaded[i];
      });
    }
  }
  return {
    config: {
      title: pack.title,
      theme: pack.theme,
      loadingText: pack.loadingText,
      permissionMode: pack.permissionMode,
      ...(backendUrl ? { backendUrl } : {}),
    },
    ...app,
    ...(containerFiles ? { containerFiles } : {}),
    assets,
    pack,
  };
}
