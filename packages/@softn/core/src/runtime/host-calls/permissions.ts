/**
 * The gate every `softn.*` host call passes: what the bundle's
 * `permission.json` declares, as the user has allowed it.
 */

import { describeNetDestination } from '../egress-policy';
import type { PermissionConfig } from '../script-runtime-types';

/**
 * What a host call's handler asks of the runtime it serves. Read at the time
 * of asking, never kept: a grant replaces the permission config after the app
 * has started, and an app can close while a handler is waiting.
 */
export interface HostGate {
  /** Throws unless the app may use `capability` now (see `requirePermission`). */
  checkPermission(capability: string): void;
  /** Throws unless the app's `net` declaration reaches `url` (see `requireNetHost`). */
  checkNetHost(url: string): void;
  /** The bundle's `permission.json` as it stands now; null when it ships none. */
  permissionConfig(): PermissionConfig | null;
  /** Whether the app has closed. */
  disposed(): boolean;
}

/** Throws, saying why and what would allow it, unless `capability` is granted. */
export function requirePermission(config: PermissionConfig | null, capability: string): void {
  if (!config) {
    // No permission.json means no capabilities. This used to allow everything
    // "for backward compatibility", which inverted the whole model: a bundle
    // that declared nothing got the network, the camera, the filesystem, AI
    // and the GPU with no prompt, while an honest bundle that declared what it
    // needed got a consent dialog the user could refuse. Declaring less bought
    // more. The user is never asked, because there is nothing to ask about —
    // the bundle claimed to need nothing.
    throw new Error(
      `${capability} access not permitted: this bundle ships no permission.json. ` +
        `Declare the capabilities it needs — { "permissions": { "${capability}": { "enabled": true } } } — ` +
        `so the user can see and approve them.`
    );
  }
  if (config.consentPending) {
    // Running with everything withheld until the user answers the consent
    // bar. Deny like any other missing capability, but say why: the bundle
    // did declare this, so telling the author to declare it is a lie the
    // user cannot act on.
    throw new Error(
      `${capability} access not permitted yet: this app has asked for it and you have not allowed it. ` +
        `Choose Allow in the permission bar at the top of the app to grant it.`
    );
  }
  // Permission config IS set — deny by default for any capability not
  // explicitly enabled. Explicitly means the boolean true: a declaration
  // spelt "enabled": "true" or 1 is what inspectDeclaration reports as
  // malformed and the consent bar requests nothing for, so a truthiness
  // check here ran the app with a capability nobody was asked about.
  const perms = config.permissions;
  switch (capability) {
    case 'net':
      if (perms.net?.enabled !== true)
        throw new Error('Network access not permitted. Add net.enabled to permission.json');
      break;
    case 'camera':
      if (perms.camera?.enabled !== true)
        throw new Error('Camera access not permitted. Add camera.enabled to permission.json');
      break;
    case 'mic':
      if (perms.mic?.enabled !== true)
        throw new Error('Microphone access not permitted. Add mic.enabled to permission.json');
      break;
    case 'files':
      if (perms.files?.enabled !== true)
        throw new Error('File access not permitted. Add files.enabled to permission.json');
      break;
    case 'qr':
      if (perms.qr?.enabled !== true)
        throw new Error('QR access not permitted. Add qr.enabled to permission.json');
      break;
    case 'ai':
      if (perms.ai?.enabled !== true)
        throw new Error('AI access not permitted. Add ai.enabled to permission.json');
      break;
    case 'gpu':
      if (perms.gpu?.enabled !== true)
        throw new Error('GPU compute access not permitted. Add gpu.enabled to permission.json');
      break;
    case 'sync':
      if (perms.sync?.enabled !== true)
        throw new Error('Sync not permitted. Add sync.enabled to permission.json');
      break;
    case 'storage':
      if (perms.storage?.enabled !== true)
        throw new Error('Server storage not permitted. Add storage.enabled to permission.json');
      break;
    case 'accel':
      if (perms.accel?.enabled !== true)
        throw new Error('Host acceleration not permitted. Add accel.enabled to permission.json');
      break;
    default:
      throw new Error(`Unknown capability: ${capability}. Add it to permission.json`);
  }
}

/**
 * Scheme, `allow_http` and `allowed_hosts`, judged by the one evaluator the
 * renderer's markup sinks and the server-sync effect also use, so a host the
 * bundle scoped itself away from is out of reach by every route rather than
 * only by `softn.net.fetch`.
 */
export function requireNetHost(config: PermissionConfig | null, url: string): void {
  const verdict = describeNetDestination(url, config?.permissions.net);
  if (!verdict.allowed) throw new Error(verdict.reason);
}
