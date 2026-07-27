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
import { ReactiveState } from '../runtime/reactivity';
import {
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
// Worker runtime available but currently all calls route through main-thread WASM VM
// for instant responsiveness. Can re-enable for heavy computation offloading if needed.
// import { createWorkerScriptRuntime } from '../runtime/script-worker-runtime';
import { getXDB, setActiveXDBApp } from '../runtime/xdb';
import { builtinHelpers } from '../runtime/helpers';
import type { SoftNDocument } from '../parser/ast';
import type { Expression, TemplateNode } from '../parser/ast';
import type { SoftNRenderContext, SoftNProps } from '../types';
import { parseStatePath } from '../runtime/state-path';

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
  // Remove @import rules (with or without url())
  sanitized = sanitized.replace(/@import\s+(?:url\s*\([^)]*\)|["'][^"']*["'])[^;]*;?/gi, '/* @import removed */');
  // Remove url() values that reference external or dangerous protocols.
  //
  // Quoted and unquoted forms are matched separately. A single pattern with
  // `[^)]*` cannot cross a literal `)`, so a URL that contains one inside its
  // quotes — `url("https://evil.test/beacon?a=(b)")`, a perfectly ordinary
  // query string — failed to match and the declaration reached the page
  // untouched. Confirmed by running the real function: the unquoted form was
  // removed, the quoted one came back unchanged.
  const isRemote = (target: string): boolean =>
    /^\s*(?:https?:|data:|javascript:|blob:|ftp:|\/\/)/i.test(target);

  const stripRemote = (pattern: RegExp) => {
    sanitized = sanitized.replace(pattern, (match, inner: string) =>
      isRemote(inner) ? 'url(/* removed */)' : match
    );
  };

  stripRemote(/url\s*\(\s*"([^"]*)"\s*\)/gi);
  stripRemote(/url\s*\(\s*'([^']*)'\s*\)/gi);
  stripRemote(/url\s*\(\s*([^)'"]*?)\s*\)/gi);
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

  // Reactive state for computed values
  const reactiveRef = useRef<ReactiveState | null>(null);
  const [, forceUpdate] = useState({});

  // Keep stateRef up-to-date on every render so snapshot reads latest state
  if (stateRef) {
    stateRef.current = () => ({
      ...state.componentState,
      ...(reactiveRef.current?.getStateSnapshot() ?? {}),
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
      window.scrollTo(scrollRef.current.x, scrollRef.current.y);
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
        element = document.querySelector(`${tagName.toLowerCase()}[name="${name}"]`);
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

  // Initialize reactive state
  useEffect(() => {
    if (!reactiveRef.current) {
      reactiveRef.current = new ReactiveState();

      // Define initial state
      for (const [name, value] of Object.entries(initialState)) {
        reactiveRef.current.defineState(name, value);
      }

      // Define computed values
      for (const [name, fn] of Object.entries(computedDefs)) {
        reactiveRef.current.defineComputed(name, () => fn(state.componentState));
      }

      // Set up effect to trigger re-renders
      reactiveRef.current.addEffect(() => {
        reactiveRef.current?.getStateSnapshot();
        forceUpdate({});
      });
    }

    return () => {
      reactiveRef.current?.dispose();
      if (syncPollRef.current) {
        clearInterval(syncPollRef.current);
        syncPollRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track if script has been initialized to avoid re-initialization
  const scriptInitializedRef = useRef(false);

  // Guard against setState after unmount (async loadScript/fetch callbacks)
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
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
                        ? Array.isArray(cloned[index]) ? [...cloned[index]] : { ...cloned[index] as Record<string, unknown> }
                        : {};
                    current = cloned[index];
                  } else {
                    const obj = current as Record<string, unknown>;
                    if (!(part in obj) || typeof obj[part] !== 'object') {
                      obj[part] = {};
                    }
                    obj[part] = Array.isArray(obj[part]) ? [...obj[part] as unknown[]] : { ...(obj[part] as Record<string, unknown>) };
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
          let effectiveMode: 'main' | 'worker' | 'hybrid-worker' = scriptExecutionMode === 'worker' ? 'worker' : 'main';
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
              incompat.push('template uses call expressions requiring synchronous script functions');
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
              console.info(
                '[SoftN] Worker hybrid mode enabled:',
                incompat.join('; ')
              );
            }
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
              permissions,
              appId,
              importResolver,
              logicBasePath,
              { mode: 'main', preIncludedLogicPaths, permissionConfig },
              bundleFileProvider,
              functions
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
          } else if (effectiveMode === 'worker') {
            // Same as hybrid: use main-thread VM for all calls. The WASM engine
            // is fast enough to run everything on the main thread without blocking UI.
            const mainRuntime = createScriptRuntime(
              formLogicContext,
              permissions,
              appId,
              importResolver,
              logicBasePath,
              { mode: 'main', preIncludedLogicPaths, permissionConfig },
              bundleFileProvider,
              functions
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
              permissions,
              appId,
              importResolver,
              logicBasePath,
              { mode: 'main', preIncludedLogicPaths, permissionConfig },
              bundleFileProvider,
              functions
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
                    const roomKey = appId ? `xdb-sync-active-room:${appId}` : 'xdb-sync-active-room';
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
                      refreshFn().then(() => {
                        polling = false;
                        if (stale || !mountedRef.current) return;
                        pollErrors = 0;
                        setState((prev) => {
                          if (prev.componentState['syncConnected'] === true) {
                            connected = true;
                          }
                          return prev;
                        });
                      }).catch(() => {
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
        onLoad?.(doc);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setState((prev) => ({
          ...prev,
          document: null,
          loading: false,
          error,
        }));
        onError?.(error);
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
  }, [resolvedSource, onLoad, onError, captureScrollAndFocus]);

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
        onError?.(error);
      });

    return () => { abortController.abort(); };
  }, [url, onLoad, onError]);

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
              ? Array.isArray(cloned[index]) ? [...cloned[index]] : { ...cloned[index] as Record<string, unknown> }
              : {};
          current = cloned[index];
        } else {
          const obj = current as Record<string, unknown>;
          if (!(part in obj) || typeof obj[part] !== 'object') {
            obj[part] = {};
          }
          obj[part] = Array.isArray(obj[part]) ? [...obj[part] as unknown[]] : { ...(obj[part] as Record<string, unknown>) };
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
    const fn = state.scriptFunctions['_onDataChange'] as ((...args: unknown[]) => Promise<unknown>) | undefined;
    if (fn) {
      fn().catch((e: unknown) => {
        console.warn('[SoftN] _onDataChange error:', e);
      });
    }
  }, [initialData, state.scriptFunctions]);

  // Get computed values from reactive state
  const computedValues = useMemo(() => {
    const reactive = reactiveRef.current;
    if (!reactive) return {};

    const snapshot = reactive.getStateSnapshot();
    const computed: Record<string, unknown> = {};

    for (const name of Object.keys(computedDefs)) {
      computed[name] = snapshot[name];
    }

    return computed;
  }, [state.componentState, computedDefs]);

  // Stable function objects — only recreated when scripts load, not every render.
  // This avoids spreading 3 large objects on every 200ms poll tick.
  const stableSyncFunctions = useMemo(() => ({
    ...(builtinHelpers as Record<string, (...args: unknown[]) => unknown>),
    ...state.scriptSyncFunctions,
    ...functions,
  }), [state.scriptSyncFunctions, functions]);

  const stableAsyncFunctions = useMemo(() => ({
    ...(builtinHelpers as Record<string, (...args: unknown[]) => unknown>),
    ...state.scriptFunctions,
    ...functions,
  }), [state.scriptFunctions, functions]);

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
      <div ref={containerRef} key={`softn-container-${stateKey}`} data-softn-page={stateKey} style={{ height: '100%', minHeight: 0 }}>
        {state.document.style?.content && (
          <style dangerouslySetInnerHTML={{ __html: sanitizeBundleCSS(state.document.style.content) }} />
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
export function useDataBlock(document: SoftNDocument | null, appId?: string): {
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

  // Build a signature to detect actual data changes (avoids unnecessary re-renders)
  const buildDataSignature = useCallback((data: Record<string, import('../types').XDBRecord[]>): string => {
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
        const field = `${record.id} ${record.updated_at || ''}`;
        for (let i = 0; i < field.length; i++) {
          hash ^= field.charCodeAt(i);
          hash = Math.imul(hash, 0x01000193);
        }
      }
      parts.push(`${key}:${records.length}:${(hash >>> 0).toString(36)}`);
    }
    return parts.join('|');
  }, []);

  /**
   * Fetch all collections synchronously (browser) or async (Tauri P2P).
   * Returns the data or null if nothing changed.
   * This is a plain function — NOT wrapped in useCallback — to avoid
   * stale closure issues with React.StrictMode double-invocation.
   */
  const doFetch = useCallback(async (
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
  }, [xdb]);

  // Refresh function exposed to callers — uses a ref to always
  // access the latest collectionDefs without stale closures.
  const collectionDefsRef = useRef(collectionDefs);
  collectionDefsRef.current = collectionDefs;

  const refresh = useCallback(() => {
    const defs = collectionDefsRef.current;
    if (defs.length === 0) return;
    doFetch(defs).then((data) => {
      if (!data) return;
      const signature = buildDataSignature(data);
      if (signature !== lastDataSignatureRef.current) {
        lastDataSignatureRef.current = signature;
        setCollections(data);
      }
    }).catch((err) => {
      console.error('[useDataBlock] Error fetching collections:', err);
      setError(err instanceof Error ? err : new Error(String(err)));
    });
  }, [doFetch, buildDataSignature]);

  // Initial fetch + subscribe to changes.
  // Runs when collectionDefs or xdb changes.
  useEffect(() => {
    let cancelled = false;

    if (collectionDefs.length > 0) {
      setLoading(true);
      doFetch(collectionDefs).then((data) => {
        if (cancelled || !data) return;
        const signature = buildDataSignature(data);
        if (signature !== lastDataSignatureRef.current) {
          lastDataSignatureRef.current = signature;
          setCollections(data);
        }
        setError(null);
      }).catch((err) => {
        if (cancelled) return;
        console.error('[useDataBlock] Error fetching collections:', err);
        setError(err instanceof Error ? err : new Error(String(err)));
      }).finally(() => {
        if (!cancelled) setLoading(false);
      });
    }

    // Subscribe to changes in all collections (debounced refresh)
    const unsubscribes: (() => void)[] = [];
    for (const def of collectionDefs) {
      const unsubscribe = xdb.subscribe(def.name, () => {
        if (cancelled) return;
        // Debounce high-frequency event bursts from sync
        if (refreshTimerRef.current) {
          clearTimeout(refreshTimerRef.current);
        }
        refreshTimerRef.current = setTimeout(() => {
          refreshTimerRef.current = null;
          if (!cancelled) {
            doFetch(collectionDefs).then((data) => {
              if (cancelled || !data) return;
              const signature = buildDataSignature(data);
              if (signature !== lastDataSignatureRef.current) {
                lastDataSignatureRef.current = signature;
                setCollections(data);
              }
            }).catch((err) => {
              if (cancelled) return;
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
  }, [xdb, collectionDefs, doFetch, buildDataSignature]);

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
      import('../runtime/xdb-sync').then((mod) => {
        setSyncModuleCache(mod);
        mod.startSync(syncOpts as unknown as import('../runtime/xdb-sync').XDBSyncOptions);
      }).catch((err) => {
        console.error('[XDB Sync] Failed to start sync:', err);
      });
    },

    stopSync: (...args: unknown[]) => {
      const room = args[0] as string | undefined;
      import('../runtime/xdb-sync').then(({ stopSync }) => {
        stopSync(room, appId);
      }).catch((err) => {
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
      try { return localStorage.getItem(key); } catch { return null; }
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
  // Parse the document to get data block
  const { document } = useSoftN(source);

  // Set up XDB data subscriptions based on data block (per-app isolation)
  const { data: xdbData, xdb } = useDataBlock(document, props.appId);

  // Create XDB helpers for the functions prop
  const xdbHelpers = useMemo(() => createXDBHelpers(xdb, syncEncryptionKeyHex, props.appId), [xdb, syncEncryptionKeyHex, props.appId]);

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
    let sync: import('../runtime/xdb-server-sync').XDBServerSync | null = null;
    let stale = false;
    import('../runtime/xdb-server-sync').then(({ XDBServerSync }) => {
      // Guard against StrictMode double-mount: the async import may resolve
      // after the first mount's cleanup has already run.
      if (stale) return;
      sync = new XDBServerSync(xdb, {
        wsUrl: serverUrl,
        appVersion: '1.0.0',
        token: serverToken,
        collections: serverCollections,
      });
      sync.connect();
      sync.on('error', (err: unknown) => {
        console.warn('[SoftN] Server sync error:', err);
      });
    }).catch(() => {
      // Server sync module not available
    });
    return () => {
      stale = true;
      sync?.disconnect();
    };
  }, [xdb, serverUrl, serverToken, serverCollections]);

  // Auto-resume sync from localStorage on mount
  const syncResumedRef = useRef(false);

  // Clean up stale sync adapters from previously opened apps on mount.
  // Fires when resumeSavedSyncRoom is not explicitly true (i.e., false or undefined).
  useEffect(() => {
    if (props.resumeSavedSyncRoom) return;
    import('../runtime/xdb-sync').then(({ stopSync }) => {
      stopSync();
    }).catch(() => {
      // Ignore sync cleanup failures in constrained environments.
    });
  }, [props.resumeSavedSyncRoom]);

  // Auto-resume sync only when explicitly opted in (resumeSavedSyncRoom === true).
  useEffect(() => {
    if (!props.resumeSavedSyncRoom) return;
    if (syncResumedRef.current) return;
    syncResumedRef.current = true;
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
  }, [xdbHelpers, props.resumeSavedSyncRoom]);

  // Notify parent of data changes
  useEffect(() => {
    onDataChange?.(xdbData);
  }, [xdbData, onDataChange]);

  // Subscribe to server-synced collections so that when XDBServerSync delivers
  // data (via upsertFromServer), we detect it and force initialData to change,
  // which triggers _onDataChange() in SoftNRenderer for script-managed state.
  const [serverSyncVersion, setServerSyncVersion] = useState(0);
  useEffect(() => {
    if (!serverCollections || serverCollections.length === 0) return;
    const unsubscribes: (() => void)[] = [];
    for (const collection of serverCollections) {
      const unsub = xdb.subscribe(collection, () => {
        setServerSyncVersion((v) => v + 1);
      });
      unsubscribes.push(unsub);
    }
    return () => unsubscribes.forEach((fn) => fn());
  }, [xdb, serverCollections]);

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
