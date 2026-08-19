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

// How @softn/components learns that the consent bar is still unanswered.
export { useConsentPending, ConsentPendingProvider } from './consent-gate';

// Dynamic loading for Tauri apps
export { useDynamicSoftN, useSoftNFiles } from './useDynamicSoftN';
export type { UseDynamicSoftNOptions, UseDynamicSoftNResult } from './useDynamicSoftN';
