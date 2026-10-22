import type { SoftnPwaOptions } from './pwa.mjs';

export declare const featureChunks: string[];
export declare const componentGroupChunks: string[];
export declare const onDemandRuntimeChunks: string[];
export declare const threeAddonChunks: string[];
export declare const vendorThreeGroup: { name: string; test: RegExp };
export declare const onDemandGlobIgnores: string[];
export declare const onDemandRuntimeCaching: NonNullable<NonNullable<SoftnPwaOptions['workbox']>['runtimeCaching']>;
