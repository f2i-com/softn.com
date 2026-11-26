import type { SoftnPwaOptions } from './pwa.mjs';

export declare const featureChunks: string[];
export declare const componentGroupChunks: string[];
export declare const onDemandRuntimeChunks: string[];
export declare const threeAddonChunks: string[];
export declare const vendorThreeGroup: { name: string; test: RegExp };
export declare const vendorReactGroup: { name: string; test: RegExp; priority: number };
export declare const vendorSyncGroup: { name: string; test: RegExp; priority: number };
export declare const vendorQrScannerGroup: { name: string; test: RegExp; priority: number };
export declare const sharedChunkGroups: Array<{ name: string; test: RegExp; priority?: number }>;
export declare const onDemandGlobIgnores: string[];
export declare const onDemandRuntimeCaching: NonNullable<NonNullable<SoftnPwaOptions['workbox']>['runtimeCaching']>;
export declare const fullEngineGlob: string;
export declare const fullEngineRuntimeCaching: (typeof onDemandRuntimeCaching)[number];
