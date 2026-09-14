/**
 * The pieces of "run one bundle in a browser" that the web runtime
 * (apps/softn-web) and the single-app shell (@softn/single-shell) share.
 *
 * - `bundleProcessor`: read a .softn archive, compose its source, seed XDB,
 *   resolve its assets and imports, and decide what its permission.json
 *   asked for and what is withheld.
 * - `zipWarmup` (+ `zipWorker`): inflate the first screen's entries off the
 *   main thread, falling back to the main thread when a worker is not
 *   available or answers too slowly.
 * - `FrameBar`: the slim bar drawn over an app that a directory served.
 *
 * These used to live in the web app and the single-app shell imported them
 * by path from the app's `src`, which made a package depend on an app.
 * The web app keeps re-export shims at the old paths.
 */
export * from './bundleProcessor';
export * from './zipWarmup';
export { FrameBar } from './FrameBar';
export type { TabInfo } from './FrameBar';
