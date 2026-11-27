/**
 * `@softn/container` — SoftN v2 Sandboxed Web App Container Runtime.
 *
 * Auto-registers `<softn-app>` in browser environments and exports the
 * programmatic container APIs. Zero React dependencies.
 */

import { defineSoftNAppElement } from './softn-app';

if (typeof window !== 'undefined' && typeof customElements !== 'undefined') {
  defineSoftNAppElement();
}

export { defineSoftNAppElement, mountSoftNContainer, type SoftNContainerHandle } from './softn-app';
export { ContainerArchive, resolveVfsPath, mimeTypeFor, VIRTUAL_ORIGIN, isLegacySoftNMarkup } from './archive';
export { selectEngineTier, loadZippEngine, engineFileFor, glueFileFor } from './zipp-loader';
export { containerRuntimeNeeds, preloadContainerFeatures, type ContainerRuntimeNeeds } from './runtime-needs';
export { transformEsModule, resolveModuleSpecifier, DEFAULT_VENDOR_IMPORT_MAP } from './esm-linker';
export { transformJsx } from './jsx-transform';
export { registerUiExtension, ensureUiExtension } from './ui-extensions/registry';
export { prepareHtmlDocument, sanitizeContainerCss, sanitizeHostAssetUrl } from './sanitize';
export { SOFTN_UI_CSS, SHADOW_HOST_BASE_CSS } from './ui-css';
export {
  VirtualCookieJar,
  RemoteBackendTransport,
  buildBackendRoutingConfig,
  matchBackendTarget,
  parseCookieHeader,
  statusTextFor,
  type BackendRoutingConfig,
  type ParsedBackendTarget,
} from './backend-transport';
export {
  LocalBackendTransport,
  clearBackendPersistedBlobs,
  SqlitePersistenceError,
  PLATFORM_MAX_PERSISTED_SQLITE_DBS,
  PLATFORM_MAX_SINGLE_SQLITE_BYTES,
  PLATFORM_MAX_TOTAL_PERSISTED_SQLITE_BYTES,
  type LocalBackendTransportOptions,
  type PersistedSqliteMeta,
  type PersistedSqliteRecord,
} from './local-backend-transport';
export {
  SQLITE_I64_MIN,
  SQLITE_I64_MAX,
  SQLITE_U64_MAX,
  sqlInt,
  sqlDecimal,
  sqlBlob,
  sqlValueToBigInt,
  bytesToHex,
  hexToBytes,
  encodeSqlParams,
  normalizeSqlParamsJson,
  parseXdbResultJson,
} from './sqlite-codec';
export {
  ContainerArtifactRegistry,
  BundleBuilderService,
  summarizeBundleArtifact,
  ARTIFACT_SCHEME,
  ARTIFACT_ID_RE,
  type RegisteredArtifact,
  type BundleArtifactSummary,
} from './bundle-service';
export { loadContainerSession, saveContainerSession, clearContainerSession, type PersistedContainerSession } from './session-store';
export { BackendWorkerSession } from './backend-runtime';
export {
  parseHtaccess,
  evaluateHtaccess,
  evaluateHtaccessChain,
  type ParsedHtaccess,
  type HtaccessRewriteRule,
  type HtaccessRewriteCond,
  type HtaccessRedirectMatch,
  type HtaccessEvalInput,
  type HtaccessEvalResult,
} from './htaccess';
export {
  loadXdbWasm,
  XdbSqlManager,
  normalizeDbKey,
  ZIPP_SQL_CAPABILITIES,
  type LoadedXdbBindings,
  type XdbWasmConnection,
  type XdbBudgetHooks,
  type XdbSqlManagerOptions,
} from './xdb-sql-bridge';
export { renderVirtualNavBar, type VirtualNavBarController } from './virtual-nav-bar';
export { SourceMapRegistry, findInlineScriptStartLines, formatCodeFrame } from './source-map';
export {
  createWebDeviceBridge,
  dispatchDeviceBridgeCall,
  type ContainerDeviceBridge,
  type DeviceInfoResult,
  type CameraPhotoOptions,
  type CameraPhotoResult,
  type BleDeviceInfo,
  type BleScanOptions,
  type LocationPositionResult,
} from './device-bridge';
export { SoftNContainerError } from './types';
export type * from './types';
