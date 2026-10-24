import { extractPermissions, inspectDeclaration, type PermissionConfig } from '@softn/core';

/**
 * What Studio's preview runs an app under: what its permission.json asks
 * for, withheld until the person allows it here, as each runtime withholds
 * it until the person allows it there.
 *
 * The preview was handed no declaration at all, which core reads as a host
 * that enforces nothing. A call from the app's logic was refused, as with
 * nothing declared, but the page's markup fetched any address it named (an
 * image whose address carried the app's state to a site of its choosing),
 * and a Camera or Microphone opened its device, whatever the project
 * declared, for a project opened from a link (`?open=`) as for one's own.
 */
export interface PreviewDeclaration {
  /** The declaration as the runtimes read it, or null for a project that declares nothing. */
  declared: PermissionConfig | null;
  /** The capabilities it asks for, by name. */
  requested: string[];
  /** What an Allow in the preview answers: this project, and this declaration of it. */
  key: string;
}

type ManifestPermissions = NonNullable<Parameters<typeof extractPermissions>[1]>['permissions'];

/**
 * The declaration of a project: its permission.json, else the manifest's old
 * `permissions` block (`manifestPermissions`), read by core as every runtime
 * reads them.
 */
export function previewDeclaration(permissionJson: string | undefined, manifestPermissions: unknown, projectId: string): PreviewDeclaration {
  const text = new Map<string, string>();
  if (typeof permissionJson === 'string') text.set('permission.json', permissionJson);
  const legacy = manifestPermissions && typeof manifestPermissions === 'object' ? (manifestPermissions as ManifestPermissions) : undefined;
  const declared = extractPermissions(text, legacy ? { permissions: legacy } : null);
  return {
    declared,
    requested: declared ? inspectDeclaration(declared).requested : [],
    key: `${projectId}\u0000${JSON.stringify(declared)}`,
  };
}

/** Nothing declared: the preview enforces, and grants nothing, as a runtime would. */
const NOTHING: PermissionConfig = Object.freeze({ permissions: Object.freeze({}) }) as PermissionConfig;

/**
 * The declaration the preview is handed: the project's own once the person
 * has allowed it in the preview (`allowedKey` is the key of what they
 * allowed), and everything it asks for withheld until then. Withheld is the
 * runtimes' shape (runtime-shell's `withheldPermissions`): no capability in
 * force, and `consentPending`, so a refused call says it has not been
 * allowed yet rather than that the project declares nothing.
 */
export function previewPermissionConfig(declaration: PreviewDeclaration, allowedKey: string | null): PermissionConfig {
  const { declared, requested, key } = declaration;
  if (!declared) return NOTHING;
  if (requested.length === 0 || allowedKey === key) return declared;
  return Object.freeze({ app: declared.app, permissions: Object.freeze({}), consentPending: true }) as PermissionConfig;
}
