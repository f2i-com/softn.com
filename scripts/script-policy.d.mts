import type { Plugin } from 'vite';

export declare function scriptPolicy(inline: string[]): string;
export declare function inlineScripts(html: string): string[];
export declare function scriptPolicyPlugin(): Plugin;
