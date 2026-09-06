/**
 * SoftN Bundle Module
 *
 * Exports for creating, reading, and running .softn bundles.
 */

export * from './types';
export * from './zip';
export * from './asset-classification';
export * from './bundle';
export * from './source-composer';
export { createBundleRuntime, SoftNBundleRenderer, useSoftNBundle } from './runtime';

// Note: CLI (cli.ts) is Node.js only and should be run directly via ts-node or compiled separately
// Example: npx ts-node src/bundle/cli.ts bundle ./demo-bundle ./demo.softn
export * from './inspect';
export * from './handoff';
