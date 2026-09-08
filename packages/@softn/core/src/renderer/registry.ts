/**
 * SoftN Component Registry
 *
 * Manages the mapping between SoftN component names and React components.
 *
 * A component is registered either eagerly — the host already holds it — or
 * lazily, as a loader the registry runs the first time something needs the
 * component. The document renderer cannot tell the two apart: `get()` answers
 * with a component for both, and for a lazy name that component is one stable
 * wrapper per name (see lazy-component.tsx) that suspends until the loader has
 * resolved. Which names are lazy, and when their loaders run, is the host's
 * decision; the registry only guarantees that a loader runs at most once per
 * generation and that a failed load can be retried.
 */

import React from 'react';
import type { SoftNProps } from '../types';
import {
  LazyComponentEntry,
  type LazyComponentOptions,
  type LazyLoadState,
  type SoftNComponentLoader,
} from './lazy-component';

export type SoftNComponent = React.ComponentType<SoftNProps>;

/** `eager` for a component registered directly; the loader's state otherwise. */
export type ComponentLoadState = 'eager' | LazyLoadState;

/**
 * Component Registry
 */
export class ComponentRegistry {
  private components: Map<string, SoftNComponent> = new Map();
  private lazyEntries: Map<string, LazyComponentEntry> = new Map();

  /**
   * Register a component
   */
  public register(name: string, component: SoftNComponent): void {
    // Last registration wins, whichever kind it is.
    this.lazyEntries.delete(name);
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
   * Register a component by loader. Nothing runs until the first render of
   * the name, or a `preload()` naming it.
   */
  public registerLazy(
    name: string,
    load: SoftNComponentLoader,
    options: LazyComponentOptions = {}
  ): void {
    this.components.delete(name);
    this.lazyEntries.set(name, new LazyComponentEntry(name, load, options));
  }

  /**
   * Register multiple components by loader
   */
  public registerAllLazy(
    entries: Record<string, SoftNComponentLoader>,
    options: LazyComponentOptions = {}
  ): void {
    for (const [name, load] of Object.entries(entries)) {
      this.registerLazy(name, load, options);
    }
  }

  /**
   * Get a component by name
   */
  public get(name: string): SoftNComponent | undefined {
    return this.components.get(name) ?? this.lazyEntries.get(name)?.wrapper;
  }

  /**
   * Check if a component is registered
   */
  public has(name: string): boolean {
    return this.components.has(name) || this.lazyEntries.has(name);
  }

  /**
   * Get all registered component names
   */
  public getNames(): string[] {
    return [...this.components.keys(), ...this.lazyEntries.keys()];
  }

  /**
   * Unregister a component
   */
  public unregister(name: string): boolean {
    const eager = this.components.delete(name);
    const lazy = this.lazyEntries.delete(name);
    return eager || lazy;
  }

  /**
   * Clear all registered components
   */
  public clear(): void {
    this.components.clear();
    this.lazyEntries.clear();
  }

  /**
   * Where a name is in its load: `eager` for a directly registered
   * component, the loader's state for a lazy one, undefined for a name the
   * registry does not know.
   */
  public getLoadState(name: string): ComponentLoadState | undefined {
    if (this.components.has(name)) return 'eager';
    return this.lazyEntries.get(name)?.getState();
  }

  /**
   * The feature a lazy name belongs to, as its registration declared it.
   */
  public getFeature(name: string): string | undefined {
    return this.lazyEntries.get(name)?.feature;
  }

  /**
   * True once rendering the name needs no load: eager, or lazy and resolved.
   */
  public isLoaded(name: string): boolean {
    if (this.components.has(name)) return true;
    return this.lazyEntries.get(name)?.getState() === 'loaded';
  }

  /**
   * Resolve a name to its component, running the loader if it has not run
   * for the current generation. Rejects for an unknown name and for a failed
   * load; the rejection is the cached one until `retry()`.
   */
  public load(name: string): Promise<SoftNComponent> {
    const eager = this.components.get(name);
    if (eager) return Promise.resolve(eager);
    const entry = this.lazyEntries.get(name);
    if (!entry) return Promise.reject(new Error(`Unknown component: ${name}`));
    return entry.load();
  }

  /**
   * Start loading every lazy name in `names` that has not started; eager
   * and unknown names are skipped, and a name already in flight or settled
   * is left alone. Settles when every load it started has settled, and
   * never rejects — a failure here is reported where the component renders.
   */
  public preload(names: Iterable<string>): Promise<void> {
    const started: Promise<unknown>[] = [];
    for (const name of new Set(names)) {
      const entry = this.lazyEntries.get(name);
      if (!entry || entry.getState() !== 'idle') continue;
      started.push(entry.load().catch(() => undefined));
    }
    return Promise.all(started).then(() => undefined);
  }

  /**
   * Discard a lazy name's cached attempt — a rejection included — and load
   * it again. Every mounted use of the name re-renders around the new
   * attempt. Resolves to the eager component for an eager name and rejects
   * for an unknown one, so a caller need not check first.
   */
  public retry(name: string): Promise<SoftNComponent> {
    const entry = this.lazyEntries.get(name);
    if (!entry) return this.load(name);
    return entry.retry();
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

/**
 * Register a component by loader in the default registry
 */
export function registerLazyComponent(
  name: string,
  load: SoftNComponentLoader,
  options?: LazyComponentOptions
): void {
  getDefaultRegistry().registerLazy(name, load, options);
}

/**
 * Register multiple components by loader in the default registry
 */
export function registerLazyComponents(
  entries: Record<string, SoftNComponentLoader>,
  options?: LazyComponentOptions
): void {
  getDefaultRegistry().registerAllLazy(entries, options);
}
