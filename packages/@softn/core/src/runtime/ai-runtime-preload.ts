/**
 * Fetch the AI runtime's page-side modules without starting anything.
 *
 * script-runtime.ts reaches the model host, the capability report and the
 * GPU compute manager by `import()`, so each is a chunk of its own that no
 * app downloads until it asks for `softn.ai`. A host installing an app that
 * declares `ai` for offline use calls this while the network is up, so the
 * service worker holds those chunks; with the local-model worker's files
 * (which the host fetches beside the other workers') a model the app has
 * already downloaded then runs offline. The models themselves are the app's
 * own downloads, kept in Cache Storage the first time each is loaded.
 *
 * The specifiers must stay the ones script-runtime.ts uses, as
 * xdb-sync-preload.ts explains: a different module would be a different chunk.
 */
export function preloadAIRuntime(): Promise<void> {
  return Promise.all([
    import('./models/model-host'),
    import('./ai-manager'),
    import('./ai-gpu-compute-manager'),
  ]).then(() => undefined);
}
