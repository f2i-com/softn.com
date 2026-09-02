/**
 * SoftN Runtime Renderer Component
 *
 * A React component that dynamically loads and renders .softn files at runtime.
 */

import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  useRef,
  Component,
} from 'react';
import { parse } from '../parser';
import { renderDocument } from '../renderer';
import { getDefaultRegistry } from '../renderer/registry';
import { rewriteCssUrls } from '../renderer/sanitize-html';
import {
  collectObservedStateNames,
  createScriptRuntime,
  detectWorkerIncompatibilities,
  createPersistentXDBModule,
  createMockNavModule,
  createConsoleModule,
  getSyncModuleCache,
  setSyncModuleCache,
  type ScriptContext,
  type ScriptRuntimeHandle,
  type ScriptRuntimeMode,
  type BundleFileProvider,
  type PermissionConfig,
} from '../runtime/script-runtime';
// The off-main-thread runtime. Reached only by `?exec=worker` for now; every
// other path routes calls through the main-thread VM. See the note where
// `forceWorker` is decided.
import { createWorkerScriptRuntime } from '../runtime/script-worker-runtime';
import { ConsentPendingProvider } from './consent-gate';
import { getXDB, setActiveXDBApp } from '../runtime/xdb';
import { builtinHelpers } from '../runtime/helpers';
import type { SoftNDocument } from '../parser/ast';
import type { Expression, TemplateNode } from '../parser/ast';
import type { SoftNRenderContext, SoftNProps } from '../types';
import { parseStatePath } from '../runtime/state-path';

/**
 * Permission manifests and pre-included path lists are JSON data, but callers
 * commonly construct them inline. Preserve the previous reference while their
 * contents are unchanged so a harmless parent re-render cannot restart the VM.
 */
function useStructurallyStableValue<T>(value: T): T {
  const serialized = JSON.stringify(value);
  const ref = useRef<{ serialized: string | undefined; value: T }>({ serialized, value });
  if (ref.current.serialized !== serialized) {
    ref.current = { serialized, value };
  }
  return ref.current.value;
}

/**
 * Sanitize CSS from bundle style blocks before injection.
 * Strips patterns that could load external resources or exfiltrate data:
 * - @import rules (external stylesheet loads)
 * - url() values pointing to http/https/data/javascript/blob URIs
 * - Protocol-relative URLs (//attacker.test/...)
 * - Encoded protocol schemes (\68ttp, \6a avascript, etc.)
 * - expression() / -moz-binding (legacy IE/Firefox code execution)
 * - behavior: (IE HTC component loading)
 * Leaves relative url() intact (e.g. fonts/images bundled with the app).
 */
export function sanitizeBundleCSS(css: string): string {
  // Strip CSS escape sequences that could bypass protocol detection
  // (e.g. \6a avascript:, \68 ttp:, \75rl)
  let sanitized = css.replace(/\\[0-9a-fA-F]{1,6}\s?/g, '_');
  // Remove @import rules (with or without url()).
  //
  // The separator is `\b` followed by any run of whitespace OR comments, not
  // `\s+`. CSS does not require whitespace between an at-keyword and the token
  // after it, and a comment is a valid separator, so `@import"…";`,
  // `@import'…';` and `@import/**/"…";` all sailed past the old pattern and
  // fetched the remote stylesheet. The `\b` is load-bearing: with the separator
  // now optional, `@importurl(` would otherwise match as `@import` + `url(...)`.
  sanitized = sanitized.replace(
    /@import\b(?:\s|\/\*[\s\S]*?\*\/)*(?:url\s*\([^)]*\)|["'][^"']*["'])[^;]*;?/gi,
    '/* @import removed */'
  );
  // Remove url() values that reference external or dangerous protocols.
  //
  // The matching lives in `rewriteCssUrls` because the inline `style={{…}}`
  // path needs the identical quoted/unquoted handling with a different verdict:
  // a style block never gets a remote url(), while an inline one only has it
  // withheld until the user answers the consent bar.
  sanitized = rewriteCssUrls(sanitized, (target) =>
    /^\s*(?:https?:|data:|javascript:|blob:|ftp:|\/\/)/i.test(target)
  );
  // Remove expression() (IE) and -moz-binding (Firefox) — code execution vectors
  sanitized = sanitized.replace(/expression\s*\([^)]*\)/gi, '/* expression removed */');
  sanitized = sanitized.replace(/-moz-binding\s*:[^;]+;?/gi, '/* -moz-binding removed */');
  // Remove behavior: (IE HTC component loading)
  sanitized = sanitized.replace(/behavior\s*:[^;]+;?/gi, '/* behavior removed */');
  return sanitized;
}

/**
 * Error Boundary for catching runtime errors in SoftN rendering
 */
interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback: (error: Error, reset: () => void) => React.ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

class SoftNErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[SoftN] Runtime error:', error);
    console.error('[SoftN] Component stack:', errorInfo.componentStack);
    this.props.onError?.(error, errorInfo);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return this.props.fallback(this.state.error, this.reset);
    }
    return this.props.children;
  }
}

export interface SoftNRendererProps {
  /**
   * The .softn source code to render
   */
  source?: string;

  /**
   * URL to fetch the .softn file from
   */
  url?: string;

  /**
   * Props to pass to the SoftN component
   */
  componentProps?: SoftNProps;

  /**
   * Permissions from the bundle manifest (controls API access in sandboxed scripts)
   */
  permissions?: import('../bundle/types').AppPermissions;

  /**
   * App identifier for localStorage namespace isolation.
   * Each app gets its own localStorage prefix (`softn:{appId}:`) to prevent
   * cross-app data leakage.
   */
  appId?: string;

  /**
   * Initial state values
   */
  initialState?: Record<string, unknown>;

  /**
   * Computed value definitions (name -> function)
   */
  computedDefs?: Record<string, (state: Record<string, unknown>) => unknown>;

  /**
   * Initial data (XDB collections)
   */
  initialData?: Record<string, unknown[]>;

  /**
   * Functions available to the component
   */
  functions?: Record<string, (...args: unknown[]) => unknown>;

  /**
   * Loading component to show while fetching
   */
  loading?: React.ReactNode;

  /**
   * Error component to show on parse errors
   */
  error?: React.ReactNode | ((error: Error) => React.ReactNode);

  /**
   * Callback when document is loaded
   */
  onLoad?: (document: SoftNDocument) => void;

  /**
   * Callback on error
   */
  onError?: (error: Error) => void;

  /**
   * Callback when the app's currentPage state changes (for URL routing)
   */
  onPageChange?: (page: string) => void;

  /**
   * Import resolver for .logic file imports.
   * Called with resolved/absolute paths, returns source code or null.
   */
  importResolver?: (path: string) => Promise<string | null>;

  /**
   * Base path of the logic file, used for resolving relative imports.
   */
  logicBasePath?: string;

  /**
   * Logic files the host already concatenated into `source` itself. An
   * `import` naming one of these is skipped instead of inlining the file a
   * second time, which would redeclare everything it defines.
   */
  preIncludedLogicPaths?: string[];

  /**
   * The bundle's parsed `permission.json`, forwarded to the script runtime so
   * capability checks reflect what the bundle actually declared.
   */
  permissionConfig?: PermissionConfig;

  /**
   * Script execution mode.
   * `worker` is currently a migration mode and falls back to main-thread execution.
   */
  scriptExecutionMode?: ScriptRuntimeMode;

  /**
   * Whether to auto-resume XDB sync room from localStorage.
   * Disable this for isolated runtimes (e.g. loader app) to avoid cross-app room leakage.
   */
  resumeSavedSyncRoom?: boolean;

  /**
   * Provider for reading files from a .softn bundle (used by AI model loading).
   */
  bundleFileProvider?: BundleFileProvider;

  /**
   * Mutable ref that receives a function to snapshot the current reactive state.
   * Call `ref.current()` to get a plain object of all state variables.
   * Useful for persisting state across page refreshes.
   */
  stateRef?: React.MutableRefObject<(() => Record<string, unknown>) | null>;
}

/**
 * Component state for SoftN renderer
 */
interface RendererState {
  document: SoftNDocument | null;
  loading: boolean;
  error: Error | null;
  componentState: Record<string, unknown>;
  scriptFunctions: Record<string, (...args: unknown[]) => unknown>;
  scriptSyncFunctions: Record<string, (...args: unknown[]) => unknown>;
  scriptComputed: Record<string, () => unknown>;
}

function expressionHasCall(expr: Expression | undefined): boolean {
  if (!expr) return false;
  if (expr.type === 'CallExpression') return true;
  if (expr.type === 'BinaryExpression') {
    return expressionHasCall(expr.left) || expressionHasCall(expr.right);
  }
  if (expr.type === 'UnaryExpression') {
    return expressionHasCall(expr.argument);
  }
  if (expr.type === 'MemberExpression') {
    return expressionHasCall(expr.object) || expressionHasCall(expr.property);
  }
  if (expr.type === 'ConditionalExpression') {
    return (
      expressionHasCall(expr.test) ||
      expressionHasCall(expr.consequent) ||
      expressionHasCall(expr.alternate)
    );
  }
  if (expr.type === 'ArrowFunctionExpression') {
    return typeof expr.body === 'string' ? false : expressionHasCall(expr.body);
  }
  if (expr.type === 'ObjectExpression') {
    return expr.properties.some((p) => expressionHasCall(p.value));
  }
  if (expr.type === 'ArrayExpression') {
    return expr.elements.some((e) => expressionHasCall(e));
  }
  if (expr.type === 'SpreadElement') {
    return expressionHasCall(expr.argument);
  }
  if (expr.type === 'TemplateLiteral') {
    return expr.expressions.some((e) => expressionHasCall(e));
  }
  return false;
}

function templateRequiresSyncCalls(nodes: TemplateNode[]): boolean {
  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i];
    if (node.type === 'Expression' && expressionHasCall(node.expression)) return true;
    if (node.type === 'IfBlock') {
      if (expressionHasCall(node.condition)) return true;
      if (templateRequiresSyncCalls(node.consequent)) return true;
      if (node.alternate) {
        if (Array.isArray(node.alternate)) {
          if (templateRequiresSyncCalls(node.alternate)) return true;
        } else {
          if (templateRequiresSyncCalls([node.alternate])) return true;
        }
      }
    } else if (node.type === 'EachBlock') {
      if (expressionHasCall(node.iterable)) return true;
      if (node.keyExpression && expressionHasCall(node.keyExpression)) return true;
      if (templateRequiresSyncCalls(node.body)) return true;
      if (node.emptyFallback && templateRequiresSyncCalls(node.emptyFallback)) return true;
    } else if (node.type === 'Element') {
      if (node.conditionalIf && expressionHasCall(node.conditionalIf)) return true;
      if (node.inlineEach && expressionHasCall(node.inlineEach.iterable)) return true;
      for (const prop of node.props) {
        if (prop.value.type === 'expression' && expressionHasCall(prop.value.value)) return true;
      }
      for (const binding of node.bindings) {
        if (expressionHasCall(binding.expression)) return true;
      }
      if (templateRequiresSyncCalls(node.children)) return true;
    } else if (node.type === 'Slot') {
      if (node.fallback && templateRequiresSyncCalls(node.fallback)) return true;
    } else if (node.type === 'TemplateSlot') {
      if (templateRequiresSyncCalls(node.children)) return true;
    }
    i++;
  }
  return false;
}

/**
 * Default runtime error fallback
 */
function DefaultRuntimeErrorFallback({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}): React.ReactElement {
  return (
    <div
      style={{
        padding: '2rem',
        backgroundColor: '#fef2f2',
        border: '1px solid #fecaca',
        borderRadius: '0.5rem',
        margin: '1rem',
      }}
    >
      <h3 style={{ color: '#dc2626', marginTop: 0 }}>Runtime Error</h3>
      <p style={{ color: '#7f1d1d' }}>{error.message}</p>
      <pre
        style={{
          backgroundColor: '#1e1e1e',
          color: '#d4d4d4',
          padding: '1rem',
          borderRadius: '0.25rem',
          overflow: 'auto',
          fontSize: '0.75rem',
        }}
      >
        {error.stack}
      </pre>
      <button
        onClick={reset}
        style={{
          marginTop: '1rem',
          padding: '0.5rem 1rem',
          backgroundColor: '#dc2626',
          color: 'white',
          border: 'none',
          borderRadius: '0.25rem',
          cursor: 'pointer',
        }}
      >
        Try Again
      </button>
    </div>
  );
}

/**
 * SoftN Renderer Component
 *
 * Renders .softn files dynamically at runtime.
 */
export function SoftNRenderer({
  source,
  url,
  componentProps = {},
  permissions,
  appId,
  initialState = {},
  computedDefs = {},
  initialData = {},
  functions = {},
  loading: loadingComponent,
  error: errorComponent,
  onLoad,
  onError,
  onPageChange,
  importResolver,
  logicBasePath,
  preIncludedLogicPaths,
  permissionConfig,
  scriptExecutionMode = 'worker',
  resumeSavedSyncRoom = false,
  bundleFileProvider,
  stateRef,
}: SoftNRendererProps): React.ReactElement | null {
  const runtimePermissions = useStructurallyStableValue(permissions);
  const runtimePermissionConfig = useStructurallyStableValue(permissionConfig);
  const runtimePreIncludedLogicPaths = useStructurallyStableValue(preIncludedLogicPaths);
  const [resolvedSource, setResolvedSource] = useState<string | undefined>(source);
  const [state, setState] = useState<RendererState>({
    document: null,
    loading: !!url,
    error: null,
    componentState: initialState,
    scriptFunctions: {},
    scriptSyncFunctions: {},
    scriptComputed: {},
  });

  // Script runtime ref for .logic execution
  const scriptRuntimeRef = useRef<ScriptRuntimeHandle | null>(null);

  // Sync poll interval ref for cleanup on unmount
  const syncPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // External computed definitions read ordinary React state. Evaluate them
  // from the current snapshot instead of putting a second, unsynchronised
  // ReactiveState store beside componentState. The old store was initialized
  // once and never updated, so both computed values and stateRef reads stayed
  // pinned to the first render after any state change.
  const computedValues = useMemo(() => {
    const computed: Record<string, unknown> = {};
    for (const [name, fn] of Object.entries(computedDefs)) {
      computed[name] = fn(state.componentState);
    }
    return computed;
  }, [computedDefs, state.componentState]);

  // Keep stateRef up-to-date on every render so snapshot reads latest state
  if (stateRef) {
    stateRef.current = () => ({
      ...state.componentState,
      ...computedValues,
    });
  }

  // Focus/scroll preservation for hot reload
  const scrollRef = useRef<{ x: number; y: number } | null>(null);
  const focusRef = useRef<{
    tagName: string;
    name?: string;
    id?: string;
    selectionStart?: number;
    selectionEnd?: number;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Capture scroll and focus before re-render
  const captureScrollAndFocus = useCallback(() => {
    // Capture scroll position
    scrollRef.current = {
      x: window.scrollX,
      y: window.scrollY,
    };

    // Capture focused element
    const activeElement = document.activeElement;
    if (activeElement && activeElement !== document.body) {
      const inputEl = activeElement as HTMLInputElement;
      focusRef.current = {
        tagName: activeElement.tagName,
        name: inputEl.name || undefined,
        id: activeElement.id || undefined,
        selectionStart: inputEl.selectionStart ?? undefined,
        selectionEnd: inputEl.selectionEnd ?? undefined,
      };
    } else {
      focusRef.current = null;
    }
  }, []);

  // Restore scroll and focus after re-render
  useLayoutEffect(() => {
    // Restore scroll position
    if (scrollRef.current) {
      const { x, y } = scrollRef.current;
      // Rendering normally leaves the viewport untouched. Avoid a redundant
      // scrollTo in that common case (and in non-layout DOMs such as jsdom,
      // where the API exists only as a noisy "not implemented" stub).
      if (window.scrollX !== x || window.scrollY !== y) {
        window.scrollTo(x, y);
      }
    }

    // Restore focus
    if (focusRef.current) {
      const { tagName, name, id, selectionStart, selectionEnd } = focusRef.current;
      let element: HTMLElement | null = null;

      // Try to find by ID first
      if (id) {
        element = document.getElementById(id);
      }

      // Try to find by name
      if (!element && name) {
        element =
          Array.from(document.querySelectorAll<HTMLElement>(tagName.toLowerCase())).find(
            (candidate) => candidate.getAttribute('name') === name
          ) ?? null;
      }

      // Try to find by tag and index within container
      if (!element && containerRef.current) {
        const elements = containerRef.current.querySelectorAll(tagName.toLowerCase());
        if (elements.length === 1) {
          element = elements[0] as HTMLElement;
        }
      }

      if (element) {
        element.focus();

        // Restore cursor position for text inputs
        if (
          (tagName === 'INPUT' || tagName === 'TEXTAREA') &&
          selectionStart !== undefined &&
          selectionEnd !== undefined
        ) {
          const inputEl = element as HTMLInputElement;
          try {
            inputEl.setSelectionRange(selectionStart, selectionEnd);
          } catch {
            // Some input types don't support selection
          }
        }
      }
    }
  }, [state.document]);

  // Clear any outstanding sync poll when the renderer leaves the tree.
  useEffect(() => {
    return () => {
      if (syncPollRef.current) {
        clearInterval(syncPollRef.current);
        syncPollRef.current = null;
      }
    };
  }, []);

  // Hold the load callbacks in refs so they cannot re-run the parse effect.
  //
  // That effect owns parsing, runtime creation, `loadScript` and `_init()`, and
  // its cleanup disposes the WASM engine and clears every script function. With
  // `onLoad`/`onError` in its dependency array, any caller passing inline
  // arrows re-ran the whole thing on every render — and the builder's
  // LivePreview does exactly that from a plain function, while subscribing to
  // whole stores with no selector, so it re-renders on selection and hover.
  // Clicking any element on the canvas therefore disposed the engine,
  // recompiled the script, re-ran its top level and called `_init()` again:
  // every button inert during the async gap, and an `_init()` that seeds
  // records duplicating them on each click.
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // Host functions are often supplied inline (the web and native loaders both
  // do this for asset()). Rebuilding the VM on each identity change would run
  // script top-level code and _init() again. A stable proxy lets long-lived
  // runtime bridges call the latest implementation while genuine runtime
  // configuration changes can remain effect dependencies.
  const functionsRef = useRef(functions);
  functionsRef.current = functions;
  const runtimeFunctions = useMemo(
    () =>
      new Proxy({} as Record<string, (...args: unknown[]) => unknown>, {
        ownKeys: () => Reflect.ownKeys(functionsRef.current),
        getOwnPropertyDescriptor: (_target, property) => {
          const descriptor = Object.getOwnPropertyDescriptor(functionsRef.current, property);
          return descriptor ? { ...descriptor, configurable: true } : undefined;
        },
        get: (_target, property) => {
          if (typeof property !== 'string') return undefined;
          return (...args: unknown[]) => functionsRef.current[property]?.(...args);
        },
      }),
    []
  );

  // Track if script has been initialized to avoid re-initialization
  const scriptInitializedRef = useRef(false);

  // Guard against setState after unmount (async loadScript/fetch callbacks)
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Point XDB's no-argument callers at this app.
  //
  // Storage is namespaced per app, but a few callers cannot reach an appId —
  // `<SmartForm collection="…">` is an ordinary component well below here, and
  // the bundle seeder is a plain module. They must resolve to the same store
  // this app's own logic uses, or a form would write records the app can never
  // read. Done during render rather than in an effect because those children
  // render before any effect runs.
  setActiveXDBApp(appId);

  // Parse source when provided directly
  useEffect(() => {
    // Per-invocation stale flag — prevents React Strict Mode double-mount from
    // allowing the first mount's async loadScript callback to run after cleanup.
    let stale = false;

    if (resolvedSource) {
      // Capture scroll/focus before re-parsing for hot reload
      captureScrollAndFocus();

      try {
        const doc = parse(resolvedSource);

        // Log parse diagnostics (fault-tolerant parsing may have recovered from errors)
        if (doc.diagnostics && doc.diagnostics.length > 0) {
          for (const diag of doc.diagnostics) {
            const prefix = `[SoftN] Parse ${diag.severity} at line ${diag.loc.line}:${diag.loc.column}:`;
            if (diag.severity === 'error') {
              console.error(prefix, diag.message);
            } else {
              console.warn(prefix, diag.message);
            }
          }
        }

        // Process script or logic block if present (only on first parse or source change)
        // Support both <script> and <logic> tags - <logic> is the preferred new syntax
        const codeBlock = doc.script || doc.logic;

        // Which state variables the markup can actually read. Derived here
        // because this is where the parsed document lives; the runtime only
        // ever sees the code block.
        const observedStateNames = collectObservedStateNames(doc) ?? undefined;

        if (codeBlock && !scriptInitializedRef.current) {
          scriptInitializedRef.current = true;

          // Create the script context with a mutable state object
          // The state will be populated by loadScript() after VM initialization
          const scriptState: Record<string, unknown> = {};
          const formLogicContext: ScriptContext = {
            state: scriptState,
            setState: (path: string, value: unknown) => {
              if (!mountedRef.current || stale) return;
              setState((prev) => {
                const parts = parseStatePath(path);
                const newState = { ...prev.componentState };
                let current: unknown = newState;
                for (let i = 0; i < parts.length - 1; i++) {
                  const part = parts[i];
                  const index = Number(part);
                  if (Array.isArray(current)) {
                    const cloned = [...current];
                    (current as unknown[])[index] = cloned[index] =
                      typeof cloned[index] === 'object' && cloned[index] !== null
                        ? Array.isArray(cloned[index])
                          ? [...cloned[index]]
                          : { ...(cloned[index] as Record<string, unknown>) }
                        : {};
                    current = cloned[index];
                  } else {
                    const obj = current as Record<string, unknown>;
                    if (!(part in obj) || typeof obj[part] !== 'object') {
                      obj[part] = {};
                    }
                    obj[part] = Array.isArray(obj[part])
                      ? [...(obj[part] as unknown[])]
                      : { ...(obj[part] as Record<string, unknown>) };
                    current = obj[part];
                  }
                }
                const lastPart = parts[parts.length - 1];
                if (Array.isArray(current)) {
                  (current as unknown[])[Number(lastPart)] = value;
                } else {
                  (current as Record<string, unknown>)[lastPart] = value;
                }
                return { ...prev, componentState: newState };
              });
            },
            batchSetState: (changes: Record<string, unknown>) => {
              if (!mountedRef.current || stale) return;
              setState((prev) => {
                const newState = { ...prev.componentState };
                for (const key of Object.keys(changes)) {
                  newState[key] = changes[key];
                }
                return { ...prev, componentState: newState };
              });
            },
            data: {},
            xdb: createPersistentXDBModule(appId),
            nav: createMockNavModule(),
            console: createConsoleModule(),
          };

          // Create script runtime (VM-based, no new Function())
          let effectiveMode: 'main' | 'worker' | 'hybrid-worker' =
            scriptExecutionMode === 'worker' ? 'worker' : 'main';
          let requiresSyncMain = false;
          let hasHostBridgeIncompat = false;
          if (scriptExecutionMode === 'worker') {
            const templateNeedsSyncCalls = templateRequiresSyncCalls(doc.template || []);
            const incompat = detectWorkerIncompatibilities(codeBlock.code || '');
            hasHostBridgeIncompat = incompat.some(
              (r) =>
                r === 'uses db bridge (synchronous host access)' ||
                r === 'uses window bridge/event APIs' ||
                r === 'uses navigator bridge APIs' ||
                r === 'uses localStorage bridge'
            );
            if (/\$:\s*/.test(codeBlock.code || '')) {
              requiresSyncMain = true;
              incompat.push('uses computed declarations ($:) requiring sync evaluation');
            }
            if (templateNeedsSyncCalls) {
              requiresSyncMain = true;
              incompat.push(
                'template uses call expressions requiring synchronous script functions'
              );
            }
            const hardIncompat = incompat.filter(
              (r) =>
                r !== 'uses db bridge (synchronous host access)' &&
                r !== 'uses window bridge/event APIs' &&
                r !== 'uses navigator bridge APIs' &&
                r !== 'uses localStorage bridge' &&
                r !== 'uses computed declarations ($:) requiring sync evaluation' &&
                r !== 'template uses call expressions requiring synchronous script functions'
            );
            if (hardIncompat.length > 0) {
              effectiveMode = 'main';
              console.info(
                '[SoftN] Worker mode fallback to main-thread runtime:',
                hardIncompat.join('; ')
              );
            } else if (requiresSyncMain || hasHostBridgeIncompat) {
              effectiveMode = 'hybrid-worker';
              console.info('[SoftN] Worker hybrid mode enabled:', incompat.join('; '));
            }
          }

          // Off-main-thread execution, opt-in by URL while it is a spike: the
          // script runs in a dedicated worker and every script function the
          // template binds returns a promise. What this buys is the main thread:
          // an emulator that costs more than a display frame to advance no
          // longer blocks the frame it is drawn in. What it does not yet have is
          // the window-event, `softn.*` and file bridges — see script-worker.ts —
          // so it is a measurement, not a mode.
          // The shell rewrites the URL to /app/<name> before this runs, so the
          // query is read from wherever it survives: the URL if it is still
          // there, else a global a harness set before the app loaded.
          const execParam =
            (typeof location !== 'undefined'
              ? new URLSearchParams(location.search).get('exec')
              : null) ??
            ((globalThis as unknown as Record<string, unknown>).__softnExec as string | undefined) ??
            null;
          const forceWorker = scriptExecutionMode === 'worker' && execParam === 'worker';
          // `?exec=main` keeps the ordinary path but still installs the hook, so
          // both sides of a measurement drive the script the same way.
          const spikeHook = execParam !== null;
          if (forceWorker) {
            effectiveMode = 'worker';
            console.info('[SoftN] Worker mode forced by ?exec=worker');
          }

          let runtime: ScriptRuntimeHandle;
          if (effectiveMode === 'hybrid-worker') {
            // Main-thread-first hybrid: ALL function calls execute on the main-thread
            // WASM VM for instant responsiveness. The WASM engine is fast enough (~20x
            // over TypeScript VM) that pollGameState + user actions complete in <5ms,
            // well within the frame budget. This eliminates:
            // - Worker RPC round-trip latency (20-100ms per button click)
            // - postMessage serialization overhead
            // - Double renders from worker state + XDB mutation callbacks
            // - State sync complexity between two VMs
            const mainRuntime = createScriptRuntime(
              formLogicContext,
              runtimePermissions,
              appId,
              importResolver,
              logicBasePath,
              {
                mode: 'main',
                preIncludedLogicPaths: runtimePreIncludedLogicPaths,
                permissionConfig: runtimePermissionConfig,
                observedStateNames,
              },
              bundleFileProvider,
              runtimeFunctions
            );
            runtime = {
              loadScript: async (script) => {
                const mainRes = await mainRuntime.loadScript(script);
                return {
                  state: mainRes.state,
                  functions: mainRes.functions,
                  syncFunctions: mainRes.syncFunctions,
                  computed: mainRes.computed,
                };
              },
              updateContext: (newState) => {
                mainRuntime.updateContext(newState);
              },
              cleanup: () => {
                mainRuntime.cleanup();
              },
            };
          } else if (effectiveMode === 'worker' && forceWorker) {
            runtime = createWorkerScriptRuntime(
              formLogicContext,
              runtimePermissions,
              appId,
              importResolver,
              logicBasePath,
              observedStateNames,
              runtimePreIncludedLogicPaths
            );
          } else if (effectiveMode === 'worker') {
            // Same as hybrid: use main-thread VM for all calls. The WASM engine
            // is fast enough to run everything on the main thread without blocking UI.
            const mainRuntime = createScriptRuntime(
              formLogicContext,
              runtimePermissions,
              appId,
              importResolver,
              logicBasePath,
              {
                mode: 'main',
                preIncludedLogicPaths: runtimePreIncludedLogicPaths,
                permissionConfig: runtimePermissionConfig,
                observedStateNames,
              },
              bundleFileProvider,
              runtimeFunctions
            );
            runtime = {
              loadScript: async (script) => {
                return mainRuntime.loadScript(script);
              },
              updateContext: (newState) => {
                mainRuntime.updateContext(newState);
              },
              cleanup: () => {
                mainRuntime.cleanup();
              },
            };
          } else {
            runtime = createScriptRuntime(
              formLogicContext,
              runtimePermissions,
              appId,
              importResolver,
              logicBasePath,
              {
                mode: 'main',
                preIncludedLogicPaths: runtimePreIncludedLogicPaths,
                permissionConfig: runtimePermissionConfig,
                observedStateNames,
              },
              bundleFileProvider,
              runtimeFunctions
            );
          }
          scriptRuntimeRef.current = runtime;

          // Load the script in the VM (async — compiles, runs, extracts state + functions)
          runtime
            .loadScript(codeBlock)
            .then((result) => {
              if (stale || !mountedRef.current) return;

              console.log('[SoftNRenderer] Script loaded successfully (VM)');
              console.log('[SoftNRenderer] Functions loaded:', Object.keys(result.functions));
              console.log(
                '[SoftNRenderer] Sync functions loaded:',
                Object.keys(result.syncFunctions)
              );
              console.log('[SoftNRenderer] Initial state:', result.state);

              // Populate the mutable context state for subsequent function calls
              Object.assign(scriptState, result.state);

              // The spike's way in for a harness: the file bridge is not in the
              // worker yet, so a cartridge is handed to the script directly.
              if (spikeHook && typeof window !== 'undefined') {
                (window as unknown as Record<string, unknown>).__softnSpike = {
                  call: (name: string, ...args: unknown[]) => {
                    const fn = result.functions[name];
                    if (typeof fn !== 'function') throw new Error(`no script function ${name}`);
                    return fn(...args);
                  },
                };
              }

              // Merge script state into componentState and set functions
              setState((prev) => {
                // Script state provides defaults; prev.componentState (from initialState) wins
                const mergedState =
                  Object.keys(result.state).length > 0
                    ? { ...result.state, ...prev.componentState }
                    : prev.componentState;

                return {
                  ...prev,
                  componentState: mergedState,
                  scriptFunctions: result.functions,
                  scriptSyncFunctions: result.syncFunctions,
                  scriptComputed: result.computed,
                };
              });

              // Call _init() convention — apps can define _init() for one-time setup
              // Must use async version (result.functions) so state changes propagate
              if (result.functions['_init']) {
                result.functions['_init']().catch((e: unknown) => {
                  console.error('[SoftN] _init error:', e);
                  if (!stale && mountedRef.current) {
                    const initError = e instanceof Error ? e : new Error(String(e));
                    setState((prev) => ({ ...prev, error: initError }));
                  }
                });
              }

              // Auto-poll sync status if there's a saved sync room
              if (resumeSavedSyncRoom && result.functions['refreshSyncStatus']) {
                try {
                  let savedRoom: string | null = null;
                  try {
                    const roomKey = appId
                      ? `xdb-sync-active-room:${appId}`
                      : 'xdb-sync-active-room';
                    savedRoom = localStorage.getItem(roomKey);
                  } catch {
                    // localStorage may be unavailable in restricted contexts
                  }
                  if (savedRoom) {
                    const refreshFn = result.functions['refreshSyncStatus'];
                    let polls = 0;
                    let connected = false;
                    let polling = false;
                    if (syncPollRef.current) clearInterval(syncPollRef.current);
                    let pollErrors = 0;
                    const pollInterval = setInterval(() => {
                      if (stale || !mountedRef.current || connected || polls >= 15) {
                        clearInterval(pollInterval);
                        if (syncPollRef.current === pollInterval) {
                          syncPollRef.current = null;
                        }
                        return;
                      }
                      // Skip if previous poll call is still in-flight
                      if (polling) return;
                      polls++;
                      polling = true;
                      refreshFn()
                        .then(() => {
                          polling = false;
                          if (stale || !mountedRef.current) return;
                          pollErrors = 0;
                          setState((prev) => {
                            if (prev.componentState['syncConnected'] === true) {
                              connected = true;
                            }
                            return prev;
                          });
                        })
                        .catch(() => {
                          polling = false;
                          pollErrors++;
                          if (pollErrors >= 3) {
                            clearInterval(pollInterval);
                            if (syncPollRef.current === pollInterval) {
                              syncPollRef.current = null;
                            }
                          }
                        });
                    }, 2000);
                    syncPollRef.current = pollInterval;
                  }
                } catch {
                  // Ignore sync bootstrap errors; app can still run without sync
                }
              }
            })
            .catch((err) => {
              if (stale || !mountedRef.current) return;
              console.error('[SoftN] Error loading script:', err);
              const scriptError = err instanceof Error ? err : new Error(String(err));
              setState((prev) => ({
                ...prev,
                error: scriptError,
                loading: false,
              }));
            });
        }

        // Set the document immediately (functions/state arrive asynchronously via loadScript).
        // Clear old script functions to prevent stale closures from calling a cleaned-up
        // runtime's vmEngine (which is null) during the gap before loadScript resolves.
        setState((prev) => ({
          ...prev,
          document: doc,
          loading: false,
          error: null,
          scriptFunctions: codeBlock ? {} : prev.scriptFunctions,
          scriptSyncFunctions: codeBlock ? {} : prev.scriptSyncFunctions,
          scriptComputed: codeBlock ? {} : prev.scriptComputed,
        }));
        onLoadRef.current?.(doc);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setState((prev) => ({
          ...prev,
          document: null,
          loading: false,
          error,
        }));
        onErrorRef.current?.(error);
      }
    }

    return () => {
      // Mark this effect invocation as stale so its async callbacks are ignored
      stale = true;

      // Clean up script runtime and sync poll on source change or unmount
      if (scriptRuntimeRef.current) {
        scriptRuntimeRef.current.cleanup();
      }
      if (syncPollRef.current) {
        clearInterval(syncPollRef.current);
        syncPollRef.current = null;
      }

      // Allow re-initialization on next mount (React Strict Mode double-mount)
      scriptInitializedRef.current = false;
    };
  }, [
    appId,
    bundleFileProvider,
    captureScrollAndFocus,
    importResolver,
    logicBasePath,
    resolvedSource,
    resumeSavedSyncRoom,
    runtimePermissionConfig,
    runtimePermissions,
    runtimePreIncludedLogicPaths,
    runtimeFunctions,
    scriptExecutionMode,
  ]);

  // Keep resolved source in sync for direct source mode.
  useEffect(() => {
    if (source !== undefined) {
      setResolvedSource(source);
    }
  }, [source]);

  // Fetch and parse from URL
  useEffect(() => {
    if (!url) return;

    const abortController = new AbortController();
    setState((prev) => ({ ...prev, loading: true, error: null }));

    fetch(url, { signal: abortController.signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
        }
        return response.text();
      })
      .then((text) => {
        if (!mountedRef.current) return;
        setResolvedSource(text);
      })
      .catch((err) => {
        if (!mountedRef.current || abortController.signal.aborted) return;
        const error = err instanceof Error ? err : new Error(String(err));
        setState((prev) => ({
          ...prev,
          document: null,
          loading: false,
          error,
        }));
        onErrorRef.current?.(error);
      });

    return () => {
      abortController.abort();
    };
  }, [url]);

  // State setter for the context
  const setComponentState = useCallback((path: string, value: unknown) => {
    setState((prev) => {
      const parts = parseStatePath(path);
      const newState = { ...prev.componentState };

      let current: unknown = newState;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        const index = Number(part);
        if (Array.isArray(current)) {
          const cloned = [...current];
          (current as unknown[])[index] = cloned[index] =
            typeof cloned[index] === 'object' && cloned[index] !== null
              ? Array.isArray(cloned[index])
                ? [...cloned[index]]
                : { ...(cloned[index] as Record<string, unknown>) }
              : {};
          current = cloned[index];
        } else {
          const obj = current as Record<string, unknown>;
          if (!(part in obj) || typeof obj[part] !== 'object') {
            obj[part] = {};
          }
          obj[part] = Array.isArray(obj[part])
            ? [...(obj[part] as unknown[])]
            : { ...(obj[part] as Record<string, unknown>) };
          current = obj[part];
        }
      }

      const lastPart = parts[parts.length - 1];
      if (Array.isArray(current)) {
        (current as unknown[])[Number(lastPart)] = value;
      } else {
        (current as Record<string, unknown>)[lastPart] = value;
      }

      // Push the new state into the script context here, before the re-render
      // this update triggers.
      //
      // `$:` computed values and sync helpers are evaluated *during* render,
      // reading the script context; the context was only refreshed by a
      // post-commit effect. So render N saw the state from render N-1, and
      // every derived value was permanently one keystroke behind — typing
      // "abc" into a `:bind` input left `$: greeting = "Hi " + name` showing
      // "Hi ab". Nothing errored; the screen was simply wrong.
      //
      // The write is an idempotent mirror of state React already owns, so a
      // discarded render (StrictMode invokes updaters twice) costs nothing —
      // and the effect below still runs after commit as the authority.
      scriptRuntimeRef.current?.updateContext(newState);

      return { ...prev, componentState: newState };
    });
  }, []);

  // Track previous initialState to detect changes from parent
  const prevInitialStateRef = useRef<Record<string, unknown>>(initialState);

  // Sync initialState changes to componentState
  // This allows parent-controlled state (like menu navigation) to update the internal state
  useEffect(() => {
    const prevState = prevInitialStateRef.current;
    let hasChanges = false;

    // Check each key in initialState for changes
    for (const key of Object.keys(initialState)) {
      const prevValue = prevState[key];
      const newValue = initialState[key];

      // If the value changed from parent, apply it to componentState
      if (newValue !== prevValue && newValue !== undefined) {
        console.log(`[SoftNRenderer] initialState change detected: ${key}`, {
          old: prevValue,
          new: newValue,
        });
        hasChanges = true;
      }
    }

    if (hasChanges) {
      setState((prev) => {
        const newComponentState = { ...prev.componentState };
        for (const key of Object.keys(initialState)) {
          const prevValue = prevState[key];
          const newValue = initialState[key];
          if (newValue !== prevValue && newValue !== undefined) {
            newComponentState[key] = newValue;
          }
        }
        return { ...prev, componentState: newComponentState };
      });
    }

    // Update ref for next comparison
    prevInitialStateRef.current = initialState;
  }, [initialState]);

  // Notify parent when currentPage changes (for URL routing)
  const currentPageValue = state.componentState['currentPage'] as string | undefined;
  const onPageChangeRef = useRef(onPageChange);
  onPageChangeRef.current = onPageChange;
  useEffect(() => {
    if (currentPageValue && onPageChangeRef.current) {
      onPageChangeRef.current(currentPageValue);
    }
  }, [currentPageValue]);

  // Sync React state changes to the script context
  // This ensures form bindings (:bind) update the context that save functions read from
  useEffect(() => {
    if (scriptRuntimeRef.current) {
      scriptRuntimeRef.current.updateContext(state.componentState);
    }
  }, [state.componentState]);

  // When initialData changes (e.g., XDB server sync delivers new records), call
  // the script's _onDataChange() convention so it can refresh derived state.
  useEffect(() => {
    const fn = state.scriptFunctions['_onDataChange'] as
      | ((...args: unknown[]) => Promise<unknown>)
      | undefined;
    if (fn) {
      fn().catch((e: unknown) => {
        console.warn('[SoftN] _onDataChange error:', e);
      });
    }
  }, [initialData, state.scriptFunctions]);

  // Stable function objects — only recreated when scripts load, not every render.
  // This avoids spreading 3 large objects on every 200ms poll tick.
  const stableSyncFunctions = useMemo(
    () => ({
      ...(builtinHelpers as Record<string, (...args: unknown[]) => unknown>),
      ...state.scriptSyncFunctions,
      ...functions,
    }),
    [state.scriptSyncFunctions, functions]
  );

  const stableAsyncFunctions = useMemo(
    () => ({
      ...(builtinHelpers as Record<string, (...args: unknown[]) => unknown>),
      ...state.scriptFunctions,
      ...functions,
    }),
    [state.scriptFunctions, functions]
  );

  const scriptLoaded = useMemo(
    () => Object.keys(state.scriptSyncFunctions).length > 0,
    [state.scriptSyncFunctions]
  );

  // Build render context - merge script functions with provided functions
  // State merging logic:
  // 1. Start with componentState (includes state updated by script functions)
  // 2. Only use initialState as DEFAULTS for keys that don't exist in componentState
  // This ensures script-initiated state changes are preserved, while initialState provides defaults
  const context = useMemo<SoftNRenderContext>(() => {
    // Merge state: componentState is the source of truth, initialState only provides defaults
    const mergedState = { ...state.componentState };
    for (const key of Object.keys(initialState)) {
      // Only apply initialState if the key doesn't exist in componentState
      if (
        !(key in state.componentState) &&
        initialState[key as keyof typeof initialState] !== undefined
      ) {
        (mergedState as Record<string, unknown>)[key] =
          initialState[key as keyof typeof initialState];
      }
    }

    return {
      state: mergedState,
      setState: setComponentState,
      data: initialData as Record<string, never>,
      props: componentProps,
      computed: {
        ...computedValues,
        ...Object.fromEntries(Object.entries(state.scriptComputed).map(([k, fn]) => [k, fn()])),
      },
      functions: stableSyncFunctions,
      asyncFunctions: stableAsyncFunctions,
      scriptLoaded,
      consentPending: runtimePermissionConfig?.consentPending === true,
    };
  }, [
    state.componentState,
    setComponentState,
    initialState,
    initialData,
    componentProps,
    computedValues,
    stableSyncFunctions,
    stableAsyncFunctions,
    scriptLoaded,
    state.scriptComputed,
    runtimePermissionConfig?.consentPending,
  ]);

  // Get the default registry
  const registry = useMemo(() => getDefaultRegistry(), []);

  // Handle loading state
  if (state.loading) {
    return loadingComponent ? <>{loadingComponent}</> : <div>Loading...</div>;
  }

  // Handle parse error state
  if (state.error) {
    if (errorComponent) {
      return (
        <>{typeof errorComponent === 'function' ? errorComponent(state.error) : errorComponent}</>
      );
    }
    // Check if error has format method (SoftNParseError)
    const errorMessage =
      'format' in state.error &&
      typeof (state.error as { format?: () => string }).format === 'function'
        ? (state.error as { format: () => string }).format()
        : state.error.message;
    return (
      <div
        style={{
          padding: '1rem',
          backgroundColor: '#fef2f2',
          border: '1px solid #fecaca',
          borderRadius: '0.5rem',
          margin: '1rem',
        }}
      >
        <h3 style={{ color: '#dc2626', marginTop: 0 }}>Parse Error</h3>
        <pre
          style={{
            backgroundColor: '#1e1e1e',
            color: '#d4d4d4',
            padding: '1rem',
            borderRadius: '0.25rem',
            overflow: 'auto',
            fontSize: '0.8rem',
            whiteSpace: 'pre-wrap',
          }}
        >
          {errorMessage}
        </pre>
      </div>
    );
  }

  // Render the document with error boundary for runtime errors
  if (state.document) {
    // Generate a key based on state values that should trigger full re-render
    // This ensures React remounts content when navigation happens
    const stateKey = (state.componentState['currentPage'] as string) ?? 'default';

    return (
      // Outside the keyed container, so a page change does not tear the
      // provider down with the page. Components below read this instead of a
      // prop: <Camera>, <QRReader> and <Microphone> open the hardware from
      // their own effects and permission.json does not cover them, so consent
      // state is the only thing standing between an entry page and the device.
      <ConsentPendingProvider value={runtimePermissionConfig?.consentPending === true}>
      <div
        ref={containerRef}
        key={`softn-container-${stateKey}`}
        data-softn-page={stateKey}
        style={{ height: '100%', minHeight: 0 }}
      >
        {state.document.style?.content && (
          <style
            dangerouslySetInnerHTML={{ __html: sanitizeBundleCSS(state.document.style.content) }}
          />
        )}
        <SoftNErrorBoundary
          fallback={(error, reset) =>
            errorComponent ? (
              typeof errorComponent === 'function' ? (
                errorComponent(error)
              ) : (
                errorComponent
              )
            ) : (
              <DefaultRuntimeErrorFallback error={error} reset={reset} />
            )
          }
          onError={(error) => onError?.(error)}
        >
          {renderDocument(state.document, context, registry)}
        </SoftNErrorBoundary>
      </div>
      </ConsentPendingProvider>
    );
  }

  return null;
}

/**
 * Hook to use SoftN rendering in custom components
 */
export function useSoftN(source: string | undefined): {
  document: SoftNDocument | null;
  error: Error | null;
  loading: boolean;
} {
  const [state, setState] = useState<{
    document: SoftNDocument | null;
    error: Error | null;
    loading: boolean;
  }>({
    document: null,
    error: null,
    loading: false,
  });

  useEffect(() => {
    if (source) {
      setState({ document: null, error: null, loading: true });
      try {
        const doc = parse(source);
        setState({ document: doc, error: null, loading: false });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setState({ document: null, error, loading: false });
      }
    } else {
      // Clearing the source must also clear the previously parsed document.
      setState({ document: null, error: null, loading: false });
    }
  }, [source]);

  return state;
}

/**
 * Hook to handle data blocks and subscribe to XDB collections
 *
 * This processes the <data> block from a SoftN document and sets up
 * subscriptions to the specified collections.
 *
 * Supports filter, sort, and limit options:
 * <collection name="tasks" as="tasks" filter={{ completed: false }} sort="createdAt:desc" limit={10} />
 */
export function useDataBlock(
  document: SoftNDocument | null,
  appId?: string
): {
  data: Record<string, import('../types').XDBRecord[]>;
  loading: boolean;
  error: Error | null;
  refresh: () => void;
  xdb: ReturnType<typeof getXDB>;
} {
  const xdb = getXDB(appId);
  const [collections, setCollections] = useState<Record<string, import('../types').XDBRecord[]>>(
    {}
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDataSignatureRef = useRef('');

  // Extract collection declarations from document
  const collectionDefs = useMemo(() => {
    if (!document?.data?.collections) return [];
    return document.data.collections.map((c) => ({
      name: c.name,
      as: c.as,
      filter: c.filter,
      sort: c.sort,
      limit: c.limit,
    }));
  }, [document]);

  // Each XDB/document pairing gets an identity that never repeats, even if a
  // caller switches A -> B -> A. Async refreshes capture this token and may
  // only publish while it is still the committed source. A layout effect makes
  // the hand-off atomic with the commit, before stale records can be painted.
  const dataSourceToken = useMemo(() => ({ xdb, collectionDefs }), [xdb, collectionDefs]);
  const activeDataSourceTokenRef = useRef<object | null>(null);
  useLayoutEffect(() => {
    activeDataSourceTokenRef.current = dataSourceToken;
    lastDataSignatureRef.current = '';
    setCollections({});
    setError(null);

    return () => {
      if (activeDataSourceTokenRef.current === dataSourceToken) {
        activeDataSourceTokenRef.current = null;
      }
    };
  }, [dataSourceToken]);

  // Build a signature to detect actual data changes (avoids unnecessary re-renders)
  const buildDataSignature = useCallback(
    (data: Record<string, import('../types').XDBRecord[]>): string => {
      const keys = Object.keys(data).sort();
      const parts: string[] = [];
      for (const key of keys) {
        const records = data[key] || [];
        // Every record contributes. Sampling only the first and last meant an
        // edit to any record between them produced an identical signature, so
        // the collection was judged unchanged and nothing re-rendered — editing
        // an item in the middle of a list did nothing on screen.
        //
        // Folded into a rolling hash (FNV-1a) rather than concatenated, so the
        // signature stays short for a large collection.
        let hash = 0x811c9dc5;
        for (const record of records) {
          const field = `${record.id}\u0000${record.updated_at || ''}\u0001`;
          for (let i = 0; i < field.length; i++) {
            hash ^= field.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193);
          }
        }
        parts.push(`${key}:${records.length}:${(hash >>> 0).toString(36)}`);
      }
      return parts.join('|');
    },
    []
  );

  /**
   * Fetch all collections synchronously (browser) or async (Tauri P2P).
   * Returns the data or null if nothing changed.
   * This is a plain function — NOT wrapped in useCallback — to avoid
   * stale closure issues with React.StrictMode double-invocation.
   */
  const doFetch = useCallback(
    async (
      defs: typeof collectionDefs
    ): Promise<Record<string, import('../types').XDBRecord[]> | null> => {
      if (defs.length === 0) return null;

      const data: Record<string, import('../types').XDBRecord[]> = {};
      const isP2P = xdb.isP2PAvailable();

      for (const def of defs) {
        // Build query options
        const queryOptions: { filter?: Record<string, unknown> } = {};

        // Evaluate filter expression if present
        if (def.filter) {
          if (def.filter.type === 'ObjectExpression') {
            const filterObj: Record<string, unknown> = {};
            for (const prop of (def.filter as import('../parser/ast').ObjectExpression)
              .properties) {
              if (prop.value.type === 'Literal') {
                filterObj[prop.key] = (
                  prop.value as import('../parser/ast').LiteralExpression
                ).value;
              } else if (prop.value.type === 'Identifier') {
                filterObj[prop.key] = (
                  prop.value as import('../parser/ast').IdentifierExpression
                ).name;
              }
            }
            queryOptions.filter = filterObj;
          }
        }

        // Fetch records
        let records: import('../types').XDBRecord[];
        if (isP2P) {
          records = queryOptions.filter
            ? await xdb.queryAsync(def.name, queryOptions)
            : await xdb.getAllAsync(def.name);
        } else {
          records = queryOptions.filter ? xdb.query(def.name, queryOptions) : xdb.getAll(def.name);
        }

        // Apply sorting if specified
        if (def.sort && Array.isArray(records)) {
          const [field, order] = def.sort.split(':');
          const sortOrder = order === 'desc' ? -1 : 1;
          records = [...records].sort((a, b) => {
            const aVal = a.data[field] ?? a[field as keyof typeof a];
            const bVal = b.data[field] ?? b[field as keyof typeof b];
            if (aVal < bVal) return -1 * sortOrder;
            if (aVal > bVal) return 1 * sortOrder;
            return 0;
          });
        }

        // Apply limit if specified
        if (def.limit && Array.isArray(records)) {
          records = records.slice(0, def.limit);
        }

        data[def.as] = records;
      }

      return data;
    },
    [xdb]
  );

  // Refresh function exposed to callers — uses a ref to always
  // access the latest collectionDefs without stale closures.
  const collectionDefsRef = useRef(collectionDefs);
  collectionDefsRef.current = collectionDefs;

  const refresh = useCallback(() => {
    const sourceToken = dataSourceToken;
    if (activeDataSourceTokenRef.current !== sourceToken) return;
    const defs = collectionDefsRef.current;
    if (defs.length === 0) return;
    doFetch(defs)
      .then((data) => {
        if (activeDataSourceTokenRef.current !== sourceToken || !data) return;
        const signature = buildDataSignature(data);
        if (signature !== lastDataSignatureRef.current) {
          lastDataSignatureRef.current = signature;
          setCollections(data);
        }
      })
      .catch((err) => {
        if (activeDataSourceTokenRef.current !== sourceToken) return;
        console.error('[useDataBlock] Error fetching collections:', err);
        setError(err instanceof Error ? err : new Error(String(err)));
      });
  }, [doFetch, buildDataSignature, dataSourceToken]);

  // Initial fetch + subscribe to changes.
  // Runs when collectionDefs or xdb changes.
  useEffect(() => {
    let cancelled = false;
    const sourceToken = dataSourceToken;
    const isCurrentSource = () => !cancelled && activeDataSourceTokenRef.current === sourceToken;

    if (collectionDefs.length > 0) {
      setLoading(true);
      doFetch(collectionDefs)
        .then((data) => {
          if (!isCurrentSource() || !data) return;
          const signature = buildDataSignature(data);
          if (signature !== lastDataSignatureRef.current) {
            lastDataSignatureRef.current = signature;
            setCollections(data);
          }
          setError(null);
        })
        .catch((err) => {
          if (!isCurrentSource()) return;
          console.error('[useDataBlock] Error fetching collections:', err);
          setError(err instanceof Error ? err : new Error(String(err)));
        })
        .finally(() => {
          if (isCurrentSource()) setLoading(false);
        });
    } else {
      setLoading(false);
    }

    // Subscribe to changes in all collections (debounced refresh)
    const unsubscribes: (() => void)[] = [];
    for (const def of collectionDefs) {
      const unsubscribe = xdb.subscribe(def.name, () => {
        if (!isCurrentSource()) return;
        // Debounce high-frequency event bursts from sync
        if (refreshTimerRef.current) {
          clearTimeout(refreshTimerRef.current);
        }
        refreshTimerRef.current = setTimeout(() => {
          refreshTimerRef.current = null;
          if (isCurrentSource()) {
            doFetch(collectionDefs)
              .then((data) => {
                if (!isCurrentSource() || !data) return;
                const signature = buildDataSignature(data);
                if (signature !== lastDataSignatureRef.current) {
                  lastDataSignatureRef.current = signature;
                  setCollections(data);
                }
              })
              .catch((err) => {
                if (!isCurrentSource()) return;
                console.error('[useDataBlock] Error refreshing collections:', err);
              });
          }
        }, 120);
      });
      unsubscribes.push(unsubscribe);
    }

    return () => {
      cancelled = true;
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      unsubscribes.forEach((unsub) => unsub());
    };
  }, [xdb, collectionDefs, doFetch, buildDataSignature, dataSourceToken]);

  return {
    data: collections,
    loading,
    error,
    refresh,
    xdb,
  };
}

/**
 * XDB helper functions to expose in the render context
 * These are synchronous wrappers that work with the XDB service
 * All functions are typed to match the SoftN function signature for compatibility
 */
export function createXDBHelpers(
  xdb: ReturnType<typeof getXDB>,
  syncEncryptionKeyHex?: string,
  appId?: string,
  /**
   * The bundle's permission.json. Omitting it denies sync, which is deliberate:
   * a caller that has not said the app may replicate its database to peers has
   * not established that the user agreed to it.
   */
  permissionConfig?: PermissionConfig
): Record<string, (...args: unknown[]) => unknown> {
  return {
    /**
     * Create a new record in a collection
     */
    create: (...args: unknown[]) => {
      const collection = args[0] as string;
      const data = args[1] as Record<string, unknown>;
      return xdb.create(collection, data);
    },

    /**
     * Update an existing record
     */
    update: (...args: unknown[]) => {
      const id = args[0] as string;
      const data = args[1] as Record<string, unknown>;
      return xdb.update(id, data);
    },

    /**
     * Delete a record (soft delete)
     */
    delete: (...args: unknown[]) => {
      const id = args[0] as string;
      return xdb.delete(id);
    },

    /**
     * Get all records from a collection
     */
    getAll: (...args: unknown[]) => {
      const collection = args[0] as string;
      return xdb.getAll(collection);
    },

    /**
     * Query records with optional filter
     */
    query: (...args: unknown[]) => {
      const collection = args[0] as string;
      const filter = args[1] as Record<string, unknown> | undefined;
      return xdb.query(collection, filter ? { filter } : undefined);
    },

    /**
     * Get a single record by ID
     */
    get: (...args: unknown[]) => {
      const collection = args[0] as string;
      const id = args[1] as string;
      return xdb.get(collection, id);
    },

    /**
     * Get the count of records in a collection
     */
    count: (...args: unknown[]) => {
      const collection = args[0] as string;
      return xdb.count(collection);
    },

    /**
     * Clear all records from a collection
     */
    clear: (...args: unknown[]) => {
      const collection = args[0] as string;
      xdb.clear(collection);
    },

    /**
     * Trigger a sync (placeholder for future P2P sync)
     */
    sync: () => {
      return xdb.sync();
    },

    startSync: (...args: unknown[]) => {
      // `sync` has always been in the capability switch, and nothing ever called
      // checkPermission('sync') — so peer-to-peer replication of the app's whole
      // database started without the user being asked, in a runtime that asks
      // before it will so much as read a file. Gated here rather than in the
      // script runtime because sync is reached through the renderer's xdb
      // helpers, not the host-call path.
      if (!permissionConfig?.permissions?.sync?.enabled) {
        // The third gate onto sync, and the last one still speaking to the
        // author. checkPermission and createDBNamespace.startSync both tell a
        // user who has not pressed Allow yet what to press; this one told them
        // to edit a file inside the bundle, which they cannot open and whose
        // author already wrote the line it asks for.
        if (permissionConfig?.consentPending) {
          throw new Error(
            'Sync not permitted yet: this app has asked to use your other devices and you ' +
              'have not allowed it. Choose Allow in the permission bar at the top of the app.'
          );
        }
        throw new Error(
          'Sync not permitted: declare { "permissions": { "sync": { "enabled": true } } } ' +
            "in the bundle's permission.json so the user can approve it."
        );
      }
      const room = args[0] as string;
      const options = args[1] as Record<string, unknown> | undefined;
      const syncOpts: Record<string, unknown> = { room, ...(options || {}) };
      const isShared = !!syncOpts.sharedRoom || !!syncOpts.noEncrypt;
      if (isShared) {
        syncOpts.password = 'softn-shared:' + room;
        delete syncOpts.encryptionKey;
      } else if (syncEncryptionKeyHex && !syncOpts.encryptionKey) {
        syncOpts.encryptionKey = syncEncryptionKeyHex;
      }
      delete syncOpts.noEncrypt;
      delete syncOpts.sharedRoom;
      if (appId && !syncOpts.appId) {
        syncOpts.appId = appId;
      }
      import('../runtime/xdb-sync')
        .then((mod) => {
          setSyncModuleCache(mod);
          mod.startSync(syncOpts as unknown as import('../runtime/xdb-sync').XDBSyncOptions);
        })
        .catch((err) => {
          console.error('[XDB Sync] Failed to start sync:', err);
        });
    },

    stopSync: (...args: unknown[]) => {
      const room = args[0] as string | undefined;
      import('../runtime/xdb-sync')
        .then(({ stopSync }) => {
          stopSync(room, appId);
        })
        .catch((err) => {
          console.error('[XDB Sync] Failed to stop sync:', err);
        });
    },

    getSyncStatus: (...args: unknown[]) => {
      const room = args[0] as string | undefined;
      const cached = getSyncModuleCache();
      if (cached) {
        const adapter = cached.getSyncAdapter(room);
        return adapter ? adapter.getStatus() : { connected: false, peers: 0, room: '', peerId: '' };
      }
      return { connected: false, peers: 0, room: '', peerId: '' };
    },

    getSavedSyncRoom: () => {
      const key = appId ? `xdb-sync-active-room:${appId}` : 'xdb-sync-active-room';
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },

    getDbPath: () => {
      return xdb.getDbPath();
    },
  };
}

/**
 * Enhanced SoftN Renderer with built-in XDB support
 *
 * This component extends SoftNRenderer by automatically processing
 * <data> blocks and making collection data available in the render context.
 */
export interface SoftNWithXDBProps extends SoftNRendererProps {
  /**
   * Callback when XDB data changes
   */
  onDataChange?: (data: Record<string, import('../types').XDBRecord[]>) => void;

  /**
   * Server sync URL (e.g. "ws://localhost:3000/sync").
   * When provided, connects to a softn-server instance for real-time data sync.
   */
  serverUrl?: string;

  /**
   * Auth token for server sync.
   */
  serverToken?: string;

  /**
   * Collections to sync with the server.
   */
  serverCollections?: string[];

  /**
   * Hex-encoded encryption key for P2P XDB sync.
   * When set, all sync signaling is encrypted with this key.
   */
  syncEncryptionKeyHex?: string;
}

export function SoftNWithXDB({
  source,
  onDataChange,
  serverUrl,
  serverToken,
  serverCollections,
  syncEncryptionKeyHex,
  ...props
}: SoftNWithXDBProps): React.ReactElement | null {
  const stablePermissionConfig = useStructurallyStableValue(props.permissionConfig);
  const stableServerCollections = useStructurallyStableValue(serverCollections);
  const consentPending = stablePermissionConfig?.consentPending === true;

  // Parse the document to get data block
  const { document } = useSoftN(source);

  // Set up XDB data subscriptions based on data block (per-app isolation)
  const { data: xdbData, xdb } = useDataBlock(document, props.appId);

  // Create XDB helpers for the functions prop
  const xdbHelpers = useMemo(
    () => createXDBHelpers(xdb, syncEncryptionKeyHex, props.appId, stablePermissionConfig),
    [xdb, syncEncryptionKeyHex, props.appId, stablePermissionConfig]
  );

  // Log per-app database path on mount
  useEffect(() => {
    xdb.getDbPath().then((path) => {
      if (path) {
        console.log(`[XDB] App "${xdb.getAppId() || '_default'}" database: ${path}`);
      }
    });
  }, [xdb]);

  // Server sync: connect to softn-server when serverUrl is provided
  useEffect(() => {
    if (!serverUrl) return;
    // `manifest.config.server.url` is a host the bundle chose, and connecting
    // to it replicates the app's collections to it. No entry in permission.json
    // describes that, so it never appears in the consent bar's list and
    // withholding the capabilities cannot touch it — the socket opened while
    // the bar still said nothing had been granted. Held on consent state
    // directly. The flag is a dependency, so the grant re-runs this effect and
    // the socket opens then, with no reload.
    if (consentPending) return;
    let sync: import('../runtime/xdb-server-sync').XDBServerSync | null = null;
    let stale = false;
    import('../runtime/xdb-server-sync')
      .then(({ XDBServerSync }) => {
        // Guard against StrictMode double-mount: the async import may resolve
        // after the first mount's cleanup has already run.
        if (stale) return;
        sync = new XDBServerSync(xdb, {
          wsUrl: serverUrl,
          appVersion: '1.0.0',
          token: serverToken,
          collections: stableServerCollections,
        });
        // Listeners first.
        //
        // `connect()` can fail synchronously — a non-localhost `ws://` URL is
        // rejected outright, with no reconnect — and it reports that by calling
        // the error listeners immediately. Registering afterwards meant the
        // message was delivered to an empty array: no console output, no UI
        // state, no retry. The app looked completely normal and simply never
        // synced.
        sync.on('error', (err: unknown) => {
          console.warn('[SoftN] Server sync error:', err);
        });
        sync.connect();
      })
      .catch(() => {
        // Server sync module not available
      });
    return () => {
      stale = true;
      sync?.disconnect();
    };
  }, [xdb, serverUrl, serverToken, stableServerCollections, consentPending]);

  // Auto-resume sync from localStorage on mount
  const syncResumedAppRef = useRef<string | null>(null);

  // Clean up THIS app's stale sync adapter on mount.
  // Fires when resumeSavedSyncRoom is not explicitly true (i.e., false or undefined).
  //
  // This used to call stopSync() with no arguments, which does not mean "drop my
  // leftovers" — it iterates every adapter in the module-level map, calls
  // provider.destroy() on each and clears it. softn-web keeps every open tab
  // mounted in one realm (App.tsx renders all openTabs and toggles them with
  // display), so opening a second app silently tore down the first one's live
  // sync: no error, no callback, and the first app's writes stopped reaching its
  // peers while still landing locally. Passing appId also clears the correct
  // namespaced localStorage key instead of the un-namespaced one, which used to
  // leave storage claiming the app was still in a room it had been cut from.
  useEffect(() => {
    if (props.resumeSavedSyncRoom) return;
    import('../runtime/xdb-sync')
      .then(({ stopSync, getSavedSyncRoom }) => {
        const saved = getSavedSyncRoom(props.appId);
        if (saved) stopSync(saved, props.appId);
      })
      .catch(() => {
        // Ignore sync cleanup failures in constrained environments.
      });
  }, [props.resumeSavedSyncRoom, props.appId]);

  // Auto-resume sync only when explicitly opted in (resumeSavedSyncRoom === true).
  useEffect(() => {
    if (!props.resumeSavedSyncRoom) {
      // Toggling the option back on should make a fresh resume attempt.
      syncResumedAppRef.current = null;
      return;
    }
    const appKey = props.appId ?? '_default';
    if (syncResumedAppRef.current === appKey) return;
    syncResumedAppRef.current = appKey;
    try {
      const key = props.appId ? `xdb-sync-active-room:${props.appId}` : 'xdb-sync-active-room';
      const savedRoom = localStorage.getItem(key);
      if (savedRoom) {
        // Check if this is a shared/multiplayer room (set by wallet App Sync).
        // Shared rooms must NOT use per-user encryption keys, otherwise different
        // users would join different signaling rooms and never discover each other.
        const sharedKey = props.appId ? `xdb-sync-shared:${props.appId}` : null;
        const isShared = sharedKey ? localStorage.getItem(sharedKey) === 'true' : false;
        if (isShared) {
          xdbHelpers.startSync(savedRoom, { sharedRoom: true });
        } else {
          xdbHelpers.startSync(savedRoom);
        }
      }
    } catch {
      // localStorage may be unavailable in restricted contexts
    }
  }, [xdbHelpers, props.appId, props.resumeSavedSyncRoom]);

  // Notify parent of data changes
  useEffect(() => {
    onDataChange?.(xdbData);
  }, [xdbData, onDataChange]);

  // Subscribe to server-synced collections so that when XDBServerSync delivers
  // data (via upsertFromServer), we detect it and force initialData to change,
  // which triggers _onDataChange() in SoftNRenderer for script-managed state.
  const [serverSyncVersion, setServerSyncVersion] = useState(0);
  useEffect(() => {
    if (!stableServerCollections || stableServerCollections.length === 0) return;
    const unsubscribes: (() => void)[] = [];
    for (const collection of stableServerCollections) {
      const unsub = xdb.subscribe(collection, () => {
        setServerSyncVersion((v) => v + 1);
      });
      unsubscribes.push(unsub);
    }
    return () => unsubscribes.forEach((fn) => fn());
  }, [xdb, stableServerCollections]);

  // Merge XDB data with initial data
  // serverSyncVersion forces a new reference when server sync data arrives,
  // even if useDataBlock has no <collection> declarations to track.
  const mergedData = useMemo(
    () => ({
      ...props.initialData,
      ...xdbData,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.initialData, xdbData, serverSyncVersion]
  );

  // Merge XDB functions with provided functions
  // XDB operations are exposed as individual functions with xdb_ prefix
  const mergedFunctions = useMemo(
    () => ({
      xdb_create: xdbHelpers.create,
      xdb_update: xdbHelpers.update,
      xdb_delete: xdbHelpers.delete,
      xdb_getAll: xdbHelpers.getAll,
      xdb_query: xdbHelpers.query,
      xdb_get: xdbHelpers.get,
      xdb_count: xdbHelpers.count,
      xdb_clear: xdbHelpers.clear,
      xdb_sync: xdbHelpers.sync,
      xdb_startSync: xdbHelpers.startSync,
      xdb_stopSync: xdbHelpers.stopSync,
      xdb_getSyncStatus: xdbHelpers.getSyncStatus,
      xdb_getSavedSyncRoom: xdbHelpers.getSavedSyncRoom,
      xdb_getDbPath: xdbHelpers.getDbPath,
      ...props.functions,
    }),
    [xdbHelpers, props.functions]
  );

  return (
    <SoftNRenderer
      {...props}
      source={source}
      initialData={mergedData}
      functions={mergedFunctions}
    />
  );
}
