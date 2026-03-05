/**
 * SoftN Component Registry
 *
 * Manages the mapping between SoftN component names and React components.
 */

import React from 'react';
import type { SoftNProps } from '../types';

export type SoftNComponent = React.ComponentType<SoftNProps>;

/**
 * Component Registry
 */
export class ComponentRegistry {
  private components: Map<string, SoftNComponent> = new Map();

  /**
   * Register a component
   */
  public register(name: string, component: SoftNComponent): void {
    this.components.set(name, component);
  }

  /**
   * Register multiple components
   */
  public registerAll(components: Record<string, SoftNComponent>): void {
    for (const [name, component] of Object.entries(components)) {
      this.register(name, component);
    }
  }

  /**
   * Get a component by name
   */
  public get(name: string): SoftNComponent | undefined {
    return this.components.get(name);
  }

  /**
   * Check if a component is registered
   */
  public has(name: string): boolean {
    return this.components.has(name);
  }

  /**
   * Get all registered component names
   */
  public getNames(): string[] {
    return Array.from(this.components.keys());
  }

  /**
   * Unregister a component
   */
  public unregister(name: string): boolean {
    return this.components.delete(name);
  }

  /**
   * Clear all registered components
   */
  public clear(): void {
    this.components.clear();
  }
}

/**
 * Default global registry
 */
let defaultRegistry: ComponentRegistry | null = null;

/**
 * Get the default component registry
 */
export function getDefaultRegistry(): ComponentRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new ComponentRegistry();
  }
  return defaultRegistry;
}

/**
 * Create a new component registry
 */
export function createRegistry(): ComponentRegistry {
  return new ComponentRegistry();
}

/**
 * Register a component in the default registry
 */
export function registerComponent(name: string, component: SoftNComponent): void {
  getDefaultRegistry().register(name, component);
}

/**
 * Register multiple components in the default registry
 */
export function registerComponents(components: Record<string, SoftNComponent>): void {
  getDefaultRegistry().registerAll(components);
}
