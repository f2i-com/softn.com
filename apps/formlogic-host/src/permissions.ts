/**
 * What the parent may let an app do in this frame: open and save the person's files, and nothing
 * else. The app's own permission.json never reaches here (FormLogic replaces it), so a bundle
 * cannot grant itself the network, the camera or sync; the parent, which asked its owner and, if
 * the owner chose so, its visitor, says what is granted, in `init.permissions`: `{ files: true }`
 * grants files, anything else nothing. It is settled before the app opens, because a grant
 * changed under a running app restarts its logic (SoftNRenderer's runtime effect).
 */
export interface FramePermissions {
  permissions: { files?: { enabled: true } };
}

export function grantedPermissions(offered: unknown): FramePermissions {
  if (!offered || typeof offered !== 'object' || Array.isArray(offered)) return { permissions: {} };
  try {
    // Cloned message data: an own, plain `true` only, so an inherited or accessor field grants nothing.
    return Object.getOwnPropertyDescriptor(offered, 'files')?.value === true ? { permissions: { files: { enabled: true } } } : { permissions: {} };
  } catch {
    return { permissions: {} };
  }
}
