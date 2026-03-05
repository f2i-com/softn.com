/**
 * SoftN Reactivity System
 *
 * Provides dependency tracking and automatic updates for computed values ($:).
 *
 * Example:
 *   let count = 0;
 *   $: doubleCount = count * 2;  // Updates when count changes
 */

export type Subscriber = () => void;
export type Getter<T> = () => T;
export type Setter<T> = (value: T) => void;

/**
 * Currently active effect (for dependency tracking)
 */
let activeEffect: ReactiveEffect | null = null;

/**
 * Effect tracking stack (for nested effects)
 */
const effectStack: ReactiveEffect[] = [];

function setActiveEffect(effect: ReactiveEffect | null): void {
  activeEffect = effect;
}

/**
 * Reactive effect that tracks dependencies
 */
export class ReactiveEffect {
  private _fn: () => void;
  private _deps: Set<Set<ReactiveEffect>> = new Set();
  private _active = true;

  constructor(fn: () => void) {
    this._fn = fn;
  }

  /**
   * Run the effect and track dependencies
   */
  run(): void {
    if (!this._active) return;

    // Clean up old dependencies
    this.cleanup();

    // Push to stack
    effectStack.push(this);
    setActiveEffect(this);

    try {
      this._fn();
    } finally {
      // Pop from stack
      effectStack.pop();
      setActiveEffect(effectStack[effectStack.length - 1] ?? null);
    }
  }

  /**
   * Add this effect as a dependency subscriber
   */
  addDep(dep: Set<ReactiveEffect>): void {
    this._deps.add(dep);
    dep.add(this);
  }

  /**
   * Clean up all dependencies
   */
  cleanup(): void {
    for (const dep of this._deps) {
      dep.delete(this);
    }
    this._deps.clear();
  }

  /**
   * Stop tracking this effect
   */
  stop(): void {
    if (this._active) {
      this.cleanup();
      this._active = false;
    }
  }
}

/**
 * Create a reactive signal (like a state variable)
 */
export function createSignal<T>(initialValue: T): [Getter<T>, Setter<T>] {
  let value = initialValue;
  const subscribers = new Set<ReactiveEffect>();

  const getter: Getter<T> = () => {
    // Track dependency
    if (activeEffect) {
      activeEffect.addDep(subscribers);
    }
    return value;
  };

  const setter: Setter<T> = (newValue: T) => {
    if (!Object.is(value, newValue)) {
      value = newValue;
      // Notify subscribers
      for (const effect of [...subscribers]) {
        effect.run();
      }
    }
  };

  return [getter, setter];
}

/**
 * Create a computed value that auto-updates when dependencies change
 */
export function createComputed<T>(fn: () => T): Getter<T> {
  let value: T;
  let dirty = true;
  const subscribers = new Set<ReactiveEffect>();

  const effect = new ReactiveEffect(() => {
    value = fn();
    dirty = false;
    // Notify subscribers of this computed
    for (const subscriber of [...subscribers]) {
      subscriber.run();
    }
  });

  return () => {
    // Track dependency on this computed
    if (activeEffect) {
      activeEffect.addDep(subscribers);
    }

    if (dirty) {
      effect.run();
    }

    return value;
  };
}

/**
 * Create an effect that runs when dependencies change
 */
export function createEffect(fn: () => void): () => void {
  const effect = new ReactiveEffect(fn);
  effect.run();

  return () => effect.stop();
}

/**
 * Batch multiple updates into a single notification
 */
let batchDepth = 0;
const pendingEffects = new Set<ReactiveEffect>();

export function batch(fn: () => void): void {
  batchDepth++;
  try {
    fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) {
      for (const effect of [...pendingEffects]) {
        pendingEffects.delete(effect);
        effect.run();
      }
    }
  }
}

/**
 * ReactiveState class for managing reactive state in SoftN components
 */
export class ReactiveState {
  private _signals: Map<string, [Getter<unknown>, Setter<unknown>]> = new Map();
  private _computed: Map<string, Getter<unknown>> = new Map();
  private _effects: (() => void)[] = [];

  /**
   * Define a reactive state variable
   */
  defineState<T>(name: string, initialValue: T): void {
    if (this._signals.has(name)) {
      console.warn(`State "${name}" is already defined`);
      return;
    }
    this._signals.set(name, createSignal(initialValue) as [Getter<unknown>, Setter<unknown>]);
  }

  /**
   * Get the current value of a state variable
   */
  get<T>(name: string): T | undefined {
    const signal = this._signals.get(name);
    if (signal) {
      return signal[0]() as T;
    }

    const computed = this._computed.get(name);
    if (computed) {
      return computed() as T;
    }

    return undefined;
  }

  /**
   * Set the value of a state variable
   */
  set<T>(name: string, value: T): void {
    const signal = this._signals.get(name);
    if (signal) {
      signal[1](value);
    } else {
      console.warn(`State "${name}" is not defined`);
    }
  }

  /**
   * Define a computed value
   */
  defineComputed<T>(name: string, fn: () => T): void {
    if (this._computed.has(name)) {
      console.warn(`Computed "${name}" is already defined`);
      return;
    }
    this._computed.set(name, createComputed(fn) as Getter<unknown>);
  }

  /**
   * Create an effect
   */
  addEffect(fn: () => void): void {
    const cleanup = createEffect(fn);
    this._effects.push(cleanup);
  }

  /**
   * Get all current state values as a plain object
   */
  getStateSnapshot(): Record<string, unknown> {
    const snapshot: Record<string, unknown> = {};

    for (const [name, signal] of this._signals) {
      snapshot[name] = signal[0]();
    }

    for (const [name, computed] of this._computed) {
      snapshot[name] = computed();
    }

    return snapshot;
  }

  /**
   * Clean up all effects
   */
  dispose(): void {
    for (const cleanup of this._effects) {
      cleanup();
    }
    this._effects = [];
  }
}

/**
 * React hook for using ReactiveState
 */
import { useState, useEffect, useCallback, useRef } from 'react';

export function useReactiveState(
  initialState: Record<string, unknown> = {},
  computedDefs: Record<string, () => unknown> = {}
): {
  state: Record<string, unknown>;
  setState: (name: string, value: unknown) => void;
  computed: Record<string, unknown>;
} {
  const reactiveRef = useRef<ReactiveState | null>(null);
  const [, forceUpdate] = useState({});

  // Initialize reactive state once
  if (!reactiveRef.current) {
    reactiveRef.current = new ReactiveState();

    // Define initial state
    for (const [name, value] of Object.entries(initialState)) {
      reactiveRef.current.defineState(name, value);
    }

    // Define computed values
    for (const [name, fn] of Object.entries(computedDefs)) {
      reactiveRef.current.defineComputed(name, fn);
    }
  }

  // Set up effect to trigger re-renders
  useEffect(() => {
    const reactive = reactiveRef.current;
    if (!reactive) return;

    reactive.addEffect(() => {
      // Get snapshot to track all dependencies
      reactive.getStateSnapshot();
      // Force React re-render
      forceUpdate({});
    });

    return () => {
      reactive.dispose();
      reactiveRef.current = null; // Allow re-initialization on Strict Mode remount
    };
  }, []);

  const setState = useCallback((name: string, value: unknown) => {
    reactiveRef.current?.set(name, value);
  }, []);

  const reactive = reactiveRef.current;
  const snapshot = reactive?.getStateSnapshot() ?? {};

  // Split into state and computed
  const state: Record<string, unknown> = {};
  const computed: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(snapshot)) {
    if (name in computedDefs) {
      computed[name] = value;
    } else {
      state[name] = value;
    }
  }

  return { state, setState, computed };
}
