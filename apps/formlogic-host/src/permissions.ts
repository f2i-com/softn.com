/**
 * What the parent may let an app do in this frame: open and save the person's files, create
 * isolated temporary SQLite workspaces, preview dynamically generated apps, or offer generated
 * bundles to the host for deployment. The app's own permission.json never reaches here (FormLogic
 * replaces it), so a bundle cannot grant itself the network, the camera, sync, or any undeclared
 * host action; the parent explicitly passes `{ files: true, 'sqlite-workspace': true, ... }`
 * in `init.permissions` as own plain booleans.
 */
export interface FramePermissions {
  permissions: {
    files?: { enabled: true };
    'sqlite-workspace'?: { enabled: true };
    'app-preview'?: { enabled: true };
    'app-deploy'?: { enabled: true };
  };
}

const PARENT_GRANTABLE_KEYS = ['files', 'sqlite-workspace', 'app-preview', 'app-deploy'] as const;

export function grantedPermissions(offered: unknown): FramePermissions {
  if (!offered || typeof offered !== 'object' || Array.isArray(offered)) return { permissions: {} };
  const permissions: FramePermissions['permissions'] = {};
  try {
    // Cloned message data: an own, plain `true` only, so an inherited or accessor field grants nothing.
    for (const key of PARENT_GRANTABLE_KEYS) {
      if (Object.getOwnPropertyDescriptor(offered, key)?.value === true) {
        permissions[key] = { enabled: true };
      }
    }
    return { permissions };
  } catch {
    return { permissions: {} };
  }
}
