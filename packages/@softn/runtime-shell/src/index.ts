/**
 * The pieces of "run one bundle in a browser" that the web runtime
 * (apps/softn-web), the single-app shell (@softn/single-shell) and the
 * desktop loader (apps/softn-loader) share.
 *
 * - `bundleProcessor`: read a .softn archive, compose its source, seed XDB,
 *   resolve its assets and imports.
 * - `net`: whether a remote import may be fetched (core's egress rule), a
 *   response body read within a bound, and the manifest's sync server.
 * - `failure`: what a host says when an app will not open.
 * - `zipWarmup` (+ `zipWorker`): inflate the first screen's entries off the
 *   main thread, falling back to the main thread when a worker is not
 *   available or answers too slowly.
 * - `FrameBar`: the slim bar drawn over an app.
 * - `consent`: what a declaration asks for, the same bundle with all of it
 *   withheld, how an Allow is remembered, and what an update newly asks for;
 *   `PermissionBar` and `PermissionPrompt` are the bar and dialog that ask.
 * - `LoadProgress`: what is downloading to run an app, on a loading screen
 *   or as a thin bar over an app already drawn.
 *
 * These used to live in the web app (and consent in three copies), and the
 * other hosts imported them by path or duplicated them.
 */
export * from './bundleProcessor';
export * from './zipWarmup';
export * from './net';
export * from './failure';
export { FrameBar } from './FrameBar';
export type { TabInfo } from './FrameBar';
export {
  DEFAULT_GRANT_PREFIX,
  diffCapabilities,
  grantCovers,
  grantKey,
  grantRecord,
  hasSavedGrant,
  saveGrant,
} from './consent';
export type { CapabilityChange, PreviousBuild } from './consent';
export { PermissionBar, CAPABILITY_PHRASE, DESKTOP_WORDING } from './PermissionBar';
export type { ConsentRequest, ConsentWording, PermissionBarProps } from './PermissionBar';
export { PermissionPrompt, PERMISSION_INFO, BROWSER_DEVICE_NOTE } from './PermissionPrompt';
export type { PermissionPromptProps } from './PermissionPrompt';
export { LoadProgress, FEATURE_LABELS } from './LoadProgress';
export type { LoadProgressProps } from './LoadProgress';
