import type { Plugin } from 'vite';

export declare function coreWorkerAssetPlugin(options?: { coreDistRoot?: string; env?: Record<string, string | undefined> }): Plugin;
export declare function minifyWorkerModules(root: string, files: readonly string[]): string[];
