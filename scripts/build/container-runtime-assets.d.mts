import type { Plugin } from 'vite';

export declare const CONTAINER_RUNTIME_DIR: string;
export declare const CONTAINER_RUNTIME_ENV: string;
export declare function isHostedRuntimeFile(relative: string): boolean;
export declare function hostedRuntimeFiles(sourceRoot?: string): string[];
export declare function containerRuntimeDigest(sourceRoot?: string): string;
export declare function copyHostedRuntime(target: string, sourceRoot?: string): string[];
export declare function sharedContainerRuntimeBase(env?: Record<string, string | undefined>): string | null;
export declare function sharedContainerPrecache(env?: Record<string, string | undefined>, sourceRoot?: string): Array<{ url: string; revision: null }>;
export declare function placeSharedContainerRuntime(outDir: string, apps: readonly string[], base: string, sourceRoot?: string): { digest: string; url: string; files: string[] };
export declare function containerRuntimeAssetPlugin(options?: { runtimeDistRoot?: string; env?: Record<string, string | undefined> }): Plugin;
