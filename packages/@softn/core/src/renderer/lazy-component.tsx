/**
 * A component the registry knows by name but has not loaded yet.
 *
 * The host registers heavy features — Scene3D and everything Three.js drags
 * in, the QR scanner, the editors — as a loader function rather than a
 * component, so a document that never mentions them never fetches them. The
 * document renderer still asks the registry for one component per tag and
 * hands its result to React as the element type, so what the registry
 * returns must be the same object on every call: a new wrapper per render
 * would make React unmount and remount the region each time, and a Scene3D
 * would lose its WebGL context on every parent re-render. One entry per
 * name, created at registration, owns that wrapper and the load state
 * behind it.
 *
 * React.lazy is the natural suspension mechanism but it caches a rejected
 * load forever: resetting an error boundary around it merely re-throws the
 * cached rejection. A retry therefore has to be a new React.lazy instance.
 * Each entry counts generations — a retry clears the cached promise, bumps
 * the generation and tells every mounted wrapper, which re-renders with the
 * new instance and a fresh boundary. The loader function itself runs at most
 * once per generation, however many wrappers or preloads ask.
 */

import React, { Component, Suspense, useRef, useSyncExternalStore } from 'react';
import type { SoftNProps } from '../types';
import type { SoftNComponent } from './registry';

/** Resolves to the component; typically `() => import('…').then((m) => m.Name)`. */
export type SoftNComponentLoader = () => Promise<SoftNComponent>;

/** Where a lazily registered component is in its life. */
export type LazyLoadState = 'idle' | 'loading' | 'loaded' | 'error';

export interface LazyComponentOptions {
  /**
   * The feature module the loader fetches, e.g. `scene3d`. Informational: a
   * host planning an offline install can ask which features a document needs.
   */
  feature?: string;
}

/**
 * The browser reports a chunk that no longer exists on the server as a
 * TypeError from `import()` — "Failed to fetch dynamically imported module",
 * "error loading dynamically imported module", "Importing a module script
 * failed" — rather than as anything naming a status code. That is what a
 * deployment looks like from a tab that was open before it: the shell that
 * is running still references the previous release's hashed file names.
 * Retrying the same URL cannot help; only a reload picks up the new shell.
 *
 * A heuristic over the message, so it is only meaningful for an error the
 * loader produced. Applied to whatever a loaded component throws while
 * rendering it matches ordinary application errors — "Texture file not found:
 * x.png", "Failed to fetch model.glb", a TypeError reading `.module` of
 * undefined — and the boundary below asks it about load failures alone.
 */
export function isMissingChunkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const message = String((error as { message?: unknown }).message ?? '');
  if (error instanceof TypeError && /import|module|fetch/i.test(message)) return true;
  return /\b404\b|not found|failed to fetch|loading (?:css )?chunk/i.test(message);
}

export class LazyComponentEntry {
  readonly name: string;
  readonly feature: string | undefined;
  /** The component the registry hands out for this name; never replaced. */
  readonly wrapper: SoftNComponent;

  private readonly loader: SoftNComponentLoader;
  private generation = 0;
  private state: LazyLoadState = 'idle';
  private promise: Promise<SoftNComponent> | null = null;
  private component: SoftNComponent | null = null;
  private error: unknown = null;
  private lazy: React.LazyExoticComponent<SoftNComponent>;
  private readonly listeners = new Set<() => void>();

  constructor(name: string, loader: SoftNComponentLoader, options: LazyComponentOptions = {}) {
    this.name = name;
    this.feature = options.feature;
    this.loader = loader;
    this.lazy = this.createLazy();
    this.wrapper = createWrapper(this);
  }

  getState(): LazyLoadState {
    return this.state;
  }

  getGeneration = (): number => this.generation;

  getComponent(): SoftNComponent | null {
    return this.component;
  }

  getError(): unknown {
    return this.error;
  }

  /** The React.lazy instance for the current generation. */
  getLazy(): React.LazyExoticComponent<SoftNComponent> {
    return this.lazy;
  }

  /**
   * Start the load if nothing has, and return the one promise for this
   * generation — in flight, settled or rejected alike. A rejection stays
   * cached on purpose: a wrapper rendering after a failure must show the
   * failure, not silently kick off another fetch on every render. `retry()`
   * is the way to try again.
   */
  load(): Promise<SoftNComponent> {
    if (this.promise) return this.promise;
    const generation = this.generation;
    this.setState('loading');
    let promise: Promise<SoftNComponent>;
    try {
      promise = Promise.resolve(this.loader()).then((component) => {
        if (typeof component !== 'function' && (!component || typeof component !== 'object')) {
          throw new Error(
            `Lazy component "${this.name}" resolved to ${String(component)}; the loader must ` +
              'return the component itself (import("…").then((m) => m.Name))'
          );
        }
        return component;
      });
    } catch (error) {
      promise = Promise.reject(error);
    }
    this.promise = promise;
    promise.then(
      (component) => {
        // A result from before a retry belongs to a generation nobody renders.
        if (generation !== this.generation) return;
        this.component = component;
        this.setState('loaded');
      },
      (error) => {
        if (generation !== this.generation) return;
        this.error = error;
        this.setState('error');
      }
    );
    return promise;
  }

  /**
   * Forget this generation's attempt — including a cached rejection — and
   * start another. Mounted wrappers learn of the new generation through
   * their subscription and remount their region around the new lazy
   * instance.
   */
  retry(): Promise<SoftNComponent> {
    this.generation += 1;
    this.promise = null;
    this.component = null;
    this.error = null;
    this.state = 'idle';
    this.lazy = this.createLazy();
    this.emit();
    return this.load();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setState(state: LazyLoadState): void {
    this.state = state;
    this.emit();
  }

  private emit(): void {
    for (const listener of Array.from(this.listeners)) listener();
  }

  private createLazy(): React.LazyExoticComponent<SoftNComponent> {
    return React.lazy(() => this.load().then((component) => ({ default: component })));
  }
}

const messageStyle: React.CSSProperties = {
  display: 'inline-flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0.5rem 0.75rem',
  margin: '0.25rem 0',
  background: 'var(--softn-error-bg, #fef2f2)',
  border: '1px solid var(--softn-error-border, #fecaca)',
  borderRadius: '6px',
  color: 'var(--softn-error-text, #b91c1c)',
  fontSize: '0.75rem',
  fontFamily: 'ui-monospace, monospace',
  lineHeight: 1.5,
};

const buttonStyle: React.CSSProperties = {
  font: 'inherit',
  padding: '0.125rem 0.5rem',
  border: '1px solid currentColor',
  borderRadius: '4px',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
};

function LazyFallback({ name }: { name: string }): React.ReactElement {
  // Sized by nothing on purpose: the region takes whatever the loaded
  // component will, and a reserved height would be a guess that is wrong for
  // every component but one.
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={`Loading ${name}`}
      data-softn-lazy={name}
      style={{ background: 'var(--softn-lazy-bg, rgba(128, 128, 128, 0.08))', borderRadius: '4px' }}
    />
  );
}

interface BoundaryProps {
  entry: LazyComponentEntry;
  children: React.ReactNode;
}

interface BoundaryState {
  error: Error | null;
}

/**
 * The boundary around one lazy region. It is keyed by generation where it is
 * rendered, so a retry replaces it rather than resetting it — the cached
 * rejection it caught belongs to the generation that is gone.
 *
 * It catches two different things and must say which: the loader's own
 * rejection, which React.lazy re-throws in render, and whatever the loaded
 * component throws while rendering. The first is about the chunk — a
 * deployment, or no network — and reloading or reconnecting can fix it. The
 * second is the app's own error, deterministic in its data; a Reload button
 * on it sends the user round a loop that ends where it started.
 */
class LazyRegionBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    const what = this.isLoadFailure(error) ? 'load' : 'render';
    console.error(`[SoftN] <${this.props.entry.name}> failed to ${what}:`, error);
    console.error('[SoftN] Component stack:', info.componentStack);
  }

  retry = (): void => {
    void this.props.entry.retry().catch(() => {
      // The boundary that replaces this one reports the new failure.
    });
  };

  reload = (): void => {
    if (typeof location !== 'undefined') location.reload();
  };

  /**
   * The entry records its generation's rejection before React.lazy throws
   * it (both are handlers on the one promise, and the entry's was attached
   * first), so identity with the recorded error is exact: anything else the
   * boundary sees came out of the component's render.
   */
  private isLoadFailure(error: unknown): boolean {
    return error === this.props.entry.getError();
  }

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { name } = this.props.entry;
    const loadFailed = this.isLoadFailure(error);
    const chunkMissing = loadFailed && isMissingChunkError(error);
    // The same import() failure means two things: online, the chunk is gone
    // from the server and only a new shell references the new name; offline,
    // it was never fetched and a reload would only fetch the same nothing.
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const updated = chunkMissing && !offline;
    const text = !loadFailed
      ? `failed to render: ${error.message}`
      : updated
        ? 'This app was updated while it was open; reload to get the current version.'
        : chunkMissing
          ? 'is not available offline; retry once connected.'
          : `could not load: ${error.message}`;
    return (
      <div role="alert" data-softn-lazy-error={name} style={messageStyle}>
        <strong>{`<${name}>`}</strong>
        <span>{text}</span>
        <button type="button" onClick={this.retry} style={buttonStyle}>
          Retry
        </button>
        {updated ? (
          <button type="button" onClick={this.reload} style={buttonStyle}>
            Reload
          </button>
        ) : null}
      </div>
    );
  }
}

function createWrapper(entry: LazyComponentEntry): SoftNComponent {
  function LazyComponent(props: SoftNProps): React.ReactElement {
    const generation = useSyncExternalStore(
      entry.subscribe,
      entry.getGeneration,
      entry.getGeneration
    );
    // Which path this mount takes is decided once per generation. A
    // component that was preloaded renders directly — React.lazy suspends at
    // least once even for a promise that has already settled, and the
    // fallback would flash for a frame. One that is still loading goes
    // through React.lazy and stays there after it resolves: switching the
    // element type on completion would remount what React.lazy just mounted.
    const decision = useRef<{ generation: number; direct: SoftNComponent | null } | null>(null);
    if (!decision.current || decision.current.generation !== generation) {
      decision.current = {
        generation,
        direct: entry.getState() === 'loaded' ? entry.getComponent() : null,
      };
    }
    // Both paths render under the region's own boundary. Whether a render
    // error stays local to the region or escapes to the document must not
    // depend on whether the chunk happened to be warm — a preload that landed
    // before first render used to skip the boundary, so the same document
    // contained a Scene3D error on a cold cache and lost the whole app on a
    // warm one. Only the Suspense is specific to the React.lazy path.
    const Direct = decision.current.direct;
    if (Direct) {
      return (
        <LazyRegionBoundary key={generation} entry={entry}>
          <Direct {...props} />
        </LazyRegionBoundary>
      );
    }
    const Lazy = entry.getLazy();
    return (
      <LazyRegionBoundary key={generation} entry={entry}>
        <Suspense fallback={<LazyFallback name={entry.name} />}>
          <Lazy {...props} />
        </Suspense>
      </LazyRegionBoundary>
    );
  }
  LazyComponent.displayName = `Lazy(${entry.name})`;
  return LazyComponent;
}
