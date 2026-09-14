/**
 * XDB - Local-First Database Service for SoftN
 *
 * Provides persistent storage with:
 * - Tauri backend with P2P sync (when running in SoftN Loader)
 * - localStorage fallback (browser standalone)
 * - Event-based reactivity for React hooks
 * - CRUD operations with automatic timestamps
 * - Automatic LAN peer discovery and CRDT-based sync
 *
 * This is the import path; the code is in four modules beside it:
 * xdb-types.ts (the shapes), xdb-service.ts (the XDBService class and its
 * two backends), xdb-registry.ts (per-app instances, preview scopes, the
 * legacy migration, signaling defaults, the script module) and
 * xdb-hooks.ts (useCollection, useRecord, useXDBStorageStatus). Every
 * export the module had is still exported from here.
 */

export * from './xdb-types';
export * from './xdb-service';
export * from './xdb-registry';
export * from './xdb-hooks';
