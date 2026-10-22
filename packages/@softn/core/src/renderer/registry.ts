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
import { HTML_ELEMENT_NAMES } from '../parser/html';
import { svgChildElement } from './html-elements';
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
 * What a component declares its props to be, where a page's markup may
 * write them otherwise: `numbers` take a number written as text
 * (`<Progress value="40">`), `choices` take one when it is one of the
 * numbers listed (a heading level, 2 to 6), and `booleans` take a number as
 * yes or no (`required={0}`). The renderer gives each prop its kind
 * (coerceDeclaredProps in render.tsx); anything else reaches the component as
 * written.
 */
export interface DeclaredPropKinds {
  numbers?: readonly string[];
  choices?: Readonly<Record<string, readonly number[]>>;
  booleans?: readonly string[];
}

/**
 * Component Registry
 */
export class ComponentRegistry {
  private components: Map<string, SoftNComponent> = new Map();
  private lazyEntries: Map<string, LazyComponentEntry> = new Map();
  /** Each registered name by its lower-case spelling, made when first asked for (see resolveName). */
  private namesByLowerCase: Map<string, string> | null = null;
  /** What each name's component declares its props to be (setPropKinds). */
  private propKinds: Map<string, DeclaredPropKinds> = new Map();

  /**
   * Register a component
   */
  public register(name: string, component: SoftNComponent): void {
    // Last registration wins, whichever kind it is, and with it what the
    // component declares: a host's own `Button` is not the built-in's.
    this.lazyEntries.delete(name);
    this.propKinds.delete(name);
    this.components.set(name, component);
    this.namesByLowerCase = null;
  }

  /**
   * What the components registered by these names declare their props to be
   * (DeclaredPropKinds), for the renderer. Given after registering them; a
   * name registered again afterwards has none until it is given again.
   */
  public setPropKinds(kinds: Readonly<Record<string, DeclaredPropKinds>>): void {
    for (const [name, declared] of Object.entries(kinds)) {
      if (this.has(name)) this.propKinds.set(name, declared);
    }
  }

  /** What the component registered as `name` declares its props to be, when it was given (setPropKinds). */
  public getPropKinds(name: string): DeclaredPropKinds | undefined {
    return this.propKinds.get(name);
  }

  /**
   * The registered name a tag means, or undefined when it means none: the
   * name as written, when it is registered; else nothing when it is an
   * element HTML or SVG names and is written as one is (`<button>`,
   * `<BUTTON>`, `<text>` in a drawing), which the page draws as that
   * element; else the registered name it spells in another case, as
   * `<datatable>` spells DataTable. Every place that turns a tag into a
   * component asks this, so a name that draws is also one that is fetched,
   * installed and checked. Two names that differ only in case are resolved
   * to the first of them in sorting order, every time.
   */
  public resolveName(tag: string): string | undefined {
    if (this.has(tag)) return tag;
    const lower = tag.toLowerCase();
    const writtenAsHtml = tag === lower || tag === tag.toUpperCase();
    if (writtenAsHtml && (HTML_ELEMENT_NAMES.has(lower) || svgChildElement(lower) !== undefined)) return undefined;
    if (!this.namesByLowerCase) {
      this.namesByLowerCase = new Map();
      for (const name of this.getNames().sort()) {
        if (!this.namesByLowerCase.has(name.toLowerCase())) this.namesByLowerCase.set(name.toLowerCase(), name);
      }
    }
    return this.namesByLowerCase.get(lower);
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
    this.propKinds.delete(name);
    this.lazyEntries.set(name, new LazyComponentEntry(name, load, options));
    this.namesByLowerCase = null;
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
    this.propKinds.delete(name);
    this.namesByLowerCase = null;
    return eager || lazy;
  }

  /**
   * Clear all registered components
   */
  public clear(): void {
    this.components.clear();
    this.lazyEntries.clear();
    this.propKinds.clear();
    this.namesByLowerCase = null;
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
    // Tags as a page writes them: `<datatable>` loads DataTable (resolveName).
    for (const name of new Set([...names].map((tag) => this.resolveName(tag) ?? tag))) {
      const entry = this.lazyEntries.get(name);
      if (!entry || entry.getState() !== 'idle') continue;
      started.push(entry.load().catch(() => undefined));
    }
    return Promise.all(started).then(() => undefined);
  }

  /**
   * What a page's first draw waits for when its first screen names `names`:
   * the loads of those registered `beforeFirstDraw` that have not finished,
   * started if idle and joined if another page started them. Null when there
   * is none, so a page whose components are all here is drawn at once, as it
   * always was. A failed load is waited for no longer than it takes to fail,
   * and is reported where the component renders; the promise never rejects.
   */
  public firstDrawLoads(names: Iterable<string>): Promise<void> | null {
    const waiting: Promise<unknown>[] = [];
    for (const name of this.firstDrawNames(names)) {
      const entry = this.lazyEntries.get(name)!;
      const state = entry.getState();
      if (state === 'loaded' || state === 'error') continue;
      waiting.push(entry.load().catch(() => undefined));
    }
    return waiting.length > 0 ? Promise.all(waiting).then(() => undefined) : null;
  }

  /**
   * The names among `names` that a first draw waits for — those registered
   * `beforeFirstDraw` — by their registered names, each once, whatever their
   * state: what a host can remember of a page to start them sooner next time
   * (first-draw-memory.ts).
   */
  public firstDrawNames(names: Iterable<string>): string[] {
    const found: string[] = [];
    for (const name of new Set([...names].map((tag) => this.resolveName(tag) ?? tag))) {
      if (this.lazyEntries.get(name)?.beforeFirstDraw) found.push(name);
    }
    return found;
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
