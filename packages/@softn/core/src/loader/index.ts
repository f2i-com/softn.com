/**
 * SoftN Loader Module
 *
 * Runtime loading and rendering of .softn files.
 */

export {
  SoftNRenderer,
  useSoftN,
  useDataBlock,
  createXDBHelpers,
  SoftNWithXDB,
} from './SoftNRenderer';
export type { SoftNRendererProps, SoftNWithXDBProps } from './SoftNRenderer';

// Dynamic loading for Tauri apps
export { useDynamicSoftN, useSoftNFiles } from './useDynamicSoftN';
export type { UseDynamicSoftNOptions, UseDynamicSoftNResult } from './useDynamicSoftN';
