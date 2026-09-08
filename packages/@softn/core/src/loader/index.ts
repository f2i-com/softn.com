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

// How @softn/components learns what the host has allowed: which capabilities
// the bundle declared and the user granted, and whether the bar is unanswered.
export {
  useConsentPending,
  useEgressConfig,
  ConsentPendingProvider,
  CapabilityProvider,
  useCapability,
  useCapabilityState,
  capabilityStatus,
  isCapabilityAllowed,
} from './consent-gate';
export type { CapabilityName, CapabilityStatus, CapabilityState } from './consent-gate';

// Which app a component is in: its store, its visibility, its assets. Read
// from context, so a handler that suspends resumes in the app it started in.
export {
  AppScopeProvider,
  useAppScope,
  useAppXDB,
  useAppActive,
  useAppAssets,
} from './app-scope';
export type { AppScope, AppAssetResolver } from './app-scope';

// Dynamic loading for Tauri apps
export { useDynamicSoftN, useSoftNFiles } from './useDynamicSoftN';
export type { UseDynamicSoftNOptions, UseDynamicSoftNResult } from './useDynamicSoftN';
