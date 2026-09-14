/** Typings for the hex-literal ratchet, for the test that compares against the baseline. */

export declare const packageRoot: string;
export declare const baselinePath: string;
/** Package-relative source file -> number of hex colour literals it carries (files with none are absent). */
export declare function countHexLiterals(): Record<string, number>;
