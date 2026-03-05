/**
 * Utility exports
 */

export {
  componentRegistry,
  getComponentsByCategory,
  getComponentMeta,
  getComponentNames,
  categoryOrder,
} from './componentRegistry';

export { generateSource, formatSource } from './sourceGenerator';

export { exportBundle, exportMultiFileBundle, parseBundle, validateManifest, saveBundleToFile } from './bundleExporter';
export type { BundleManifest, BundleOptions } from './bundleExporter';

export { loadBundle, openBundleFile, selectBundleFile } from './bundleLoader';
export type { LoadedBundle } from './bundleLoader';

export { parseSource, parseLogicFile } from './sourceParser';

export { validateBundle } from './bundleValidator';
export type { ValidationResult } from './bundleValidator';

export { debug, debugWarn } from './debug';
