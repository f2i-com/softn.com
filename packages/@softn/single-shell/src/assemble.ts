/**
 * The steps every single-app host takes once it holds a bundle's text: read
 * the manifest, settle the permission declaration, compose the source, seed
 * XDB and key the visitor's grant. The archive-served shell (`load.ts`) and
 * the PHP-served variant (apps/softn-single-private) differ only in where
 * the text and the binary entries come from, so this is where they agree —
 * a bundle that opens on one host opens on the other, with the same grant
 * scope and the same refusal message.
 */
import { ManifestError, type PermissionConfig } from '@softn/core';
import {
  extractPermissions,
  loadXDBData,
  processBundle,
  type BundleManifest,
} from '@softn/runtime-shell/bundleProcessor';
import { digest, parsePermissions } from './config';

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
};

export async function assembleApplication(input: AssembleInput): Promise<AssembledApplication> {
  const { textFiles, sidecar, appId, grantScope, signal } = input;
  // The one manifest read every host shares (core's readManifest or
  // normalizeManifest): a manifest without `files` opens here as it does in
  // the launcher, and what cannot run is refused in the inspector's words.
  let raw: BundleManifest;
  try {
    raw = input.readManifest();
  } catch (e) {
    throw Error(`Invalid application manifest: ${e instanceof ManifestError ? e.message : String(e)}`);
  }
  // Operator sidecar, then the bundle's permission.json, then its legacy
  // manifest declaration, then nothing.
  const declared = sidecar
    ? parsePermissions(await sidecar())
    : textFiles.has('permission.json')
      ? parsePermissions(JSON.parse(textFiles.get('permission.json')!))
      : parsePermissions(extractPermissions(textFiles, raw) ?? { permissions: {} });
  mark('softn:compose:start');
  const source = processBundle(textFiles, raw);
  mark('softn:compose:end');
  mark('softn:xdb-seed:start');
  await loadXDBData(textFiles, raw, appId);
  mark('softn:xdb-seed:end');
  signal.throwIfAborted();
  // Consent is build- and policy-specific, including host restrictions, not
  // just capability names: the page, the bundle bytes and the declaration.
  const grantKey =
    'single-grant:' + (await digest(new TextEncoder().encode(grantScope + JSON.stringify(declared))));
  signal.throwIfAborted();
  // Read the way inspectBundle reads it: only the literal 'worker' asks for a
  // worker, and anything else, a misspelling included, is main. Whether the
  // script can in fact leave the main thread is still the renderer's decision.
  const execution: 'worker' | 'main' = raw.config?.execution === 'worker' ? 'worker' : 'main';
  return { raw, declared, grantKey, appId, textFiles, execution, ...source };
}
