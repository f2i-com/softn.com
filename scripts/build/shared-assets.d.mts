export declare const SHARED_ASSET: RegExp;
export declare function sharedAssetsBase(env?: Record<string, string | undefined>): string | null;
export declare function sharedRenderBuiltUrl(filename: string): string | undefined;
export declare function sharedPrecacheUrl(file: string, base?: string | null): string;
export declare function collectSharedAssets(outDir: string, apps: readonly string[], base: string): string[];
