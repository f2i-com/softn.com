export declare const SHARED_ASSET: RegExp;
export declare function sharedAssetsBase(env?: Record<string, string | undefined>): string | null;
export declare function sharedRenderBuiltUrl(filename: string, context?: { type?: 'asset' | 'public'; hostId?: string; hostType?: 'js' | 'css' | 'html'; ssr?: boolean }): string | undefined;
export declare function sharedPrecacheUrl(file: string, base?: string | null): string;
export declare function sharedNameOf(manifest: Record<string, { file?: string }>, key: RegExp): string | null;
export declare function woff2OnlyFontsPlugin(): import('vite').Plugin;
export declare function collectSharedAssets(outDir: string, apps: readonly string[], base: string): { names: string[]; copies: number };
