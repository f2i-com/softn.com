import type { UserConfig } from 'vitest/config';

export declare const DEDUPE: string[];
export declare const COVERAGE_EXCLUDE: string[];
/** The shared vitest config with a workspace's `test`/`resolve` merged one level deep; see the .mjs. */
export declare function defineWorkspaceTest(overrides?: UserConfig): UserConfig;
