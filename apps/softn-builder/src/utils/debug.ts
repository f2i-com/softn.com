/**
 * Debug logging utility - only logs in development mode
 *
 * In production builds, Vite replaces `import.meta.env?.DEV` with `false`
 * and the bundler tree-shakes the logging functions to no-ops.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// Use a type assertion to avoid needing vite/client types
const meta = (import.meta as any);
const isDev: boolean = meta.env ? meta.env.DEV : true;

export const debug: (...args: any[]) => void = isDev
  ? (...args: any[]) => console.log(...args)
  : () => {};

export const debugWarn: (...args: any[]) => void = isDev
  ? (...args: any[]) => console.warn(...args)
  : () => {};
