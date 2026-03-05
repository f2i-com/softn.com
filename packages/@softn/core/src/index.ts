/**
 * SoftN Core Engine
 *
 * Main entry point for the SoftN UI language engine.
 */

// Parser exports
export * from './parser';

// Renderer exports
export * from './renderer';

// Runtime exports
export * from './runtime';

// Loader exports
export * from './loader';

// Template generators
export * from './templates';

// Bundle format
export * from './bundle';

// Types
export * from './types';

// Convenience re-exports
import React from 'react';
import { parse } from './parser';
import { renderDocument, ComponentRegistry, getDefaultRegistry } from './renderer';
import type { SoftNDocument } from './parser';
import type { SoftNRenderContext } from './types';

/**
 * Main SoftN engine class for rendering .softn files
 */
export class SoftNEngine {
  private registry: ComponentRegistry;

  constructor(registry?: ComponentRegistry) {
    this.registry = registry ?? getDefaultRegistry();
  }

  /**
   * Parse a .softn source string into a document
   */
  public parse(source: string): SoftNDocument {
    return parse(source);
  }

  /**
   * Render a SoftN document
   */
  public render(document: SoftNDocument, context: SoftNRenderContext): React.ReactNode {
    return renderDocument(document, context, this.registry);
  }

  /**
   * Parse and render a .softn source string
   */
  public renderSource(source: string, context: SoftNRenderContext): React.ReactNode {
    const document = this.parse(source);
    return this.render(document, context);
  }

  /**
   * Get the component registry
   */
  public getRegistry(): ComponentRegistry {
    return this.registry;
  }
}

/**
 * Create a new SoftN engine instance
 */
export function createEngine(registry?: ComponentRegistry): SoftNEngine {
  return new SoftNEngine(registry);
}

/**
 * Default engine instance
 */
let defaultEngine: SoftNEngine | null = null;

/**
 * Get the default SoftN engine
 */
export function getDefaultEngine(): SoftNEngine {
  if (!defaultEngine) {
    defaultEngine = createEngine();
  }
  return defaultEngine;
}
