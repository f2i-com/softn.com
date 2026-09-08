/**
 * Fetch the peer-sync runtime without starting it.
 *
 * `startSync` in script-runtime.ts and SoftNRenderer.tsx reaches xdb-sync by
 * `import('./xdb-sync')`, so the module — with yjs, y-webrtc and y-indexeddb
 * behind it — is a chunk of its own that nothing downloads until an app
 * joins a room. That is the right default and the wrong outcome for an app
 * being installed offline: the app opens, the user presses "share", and the
 * chunk is not there. A host installing such an app calls this while the
 * network is up, so the same chunk is fetched once and the service worker's
 * runtime cache holds it.
 *
 * The specifier below must stay the one those call sites use. A bundler
 * splits on the module, not on the string, but a different module — a
 * re-export, a wrapper — would be a different chunk, fetched in addition to
 * the one the app will actually ask for.
 */
export function preloadSyncRuntime(): Promise<void> {
  return import('./xdb-sync').then(() => undefined);
}
