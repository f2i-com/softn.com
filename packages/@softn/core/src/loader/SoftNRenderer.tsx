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
  useSyncExternalStore,
  Component,
} from 'react';
import { parseCached } from '../parser';
import { renderDocument } from '../renderer';
import { rootProps, shellOwnsTag } from '../renderer/render';
import { sameSiteAddress } from '../renderer/html-elements';
import { hasPageHandlers, SHELL_HTML_ID, usesDocument } from '../document-shell/names';
import type { DocumentShell } from '../document-shell/host';
import type { DocumentShellRequest } from '../runtime/script-runtime';
import { createRenderCache, type SoftNRenderCache } from '../renderer/reuse';
import { getDefaultRegistry } from '../renderer/registry';
import { collectFirstScreenTags } from '../renderer/document-tags';
import { rememberFirstDraw } from '../renderer/first-draw-memory';
import {
  isRemoteUrl,
  removeCssFunction,
  removeCssImports,
  rewriteCssResources,
  stripCssComments,
} from '../renderer/sanitize-html';
import { showBundleFilesInStyles } from '../renderer/html-elements';
import {
  collectDrawnNames,
  collectObservedStateNames,
  createScriptRuntime,
  detectWorkerIncompatibilities,
  createPersistentXDBModule,
  createMockNavModule,
  createConsoleModule,
  type ScriptContext,
  type ScriptRuntimeHandle,
  type ScriptRuntimeMode,
  type BundleFileProvider,
  type NetFetchHandler,
  type PermissionConfig,
  type PersistenceFailure,
} from '../runtime/script-runtime';
// The off-main-thread runtime, loaded behind a handle for an app that asks for
// a worker; every other path routes calls through the main-thread VM. See the
// note where `forceWorker` is decided.
import { createWorkerScriptRuntimeLazily } from '../runtime/script-worker-runtime-lazy';
import { declaredFunctionNames, standInFunctions } from '../runtime/declared-functions';
import { logicEngineIsSandboxed, logicEngineThreads, type PythonProject } from '../runtime/vm-adapter';
import { CapabilityProvider, type CapabilityState } from './consent-gate';
import { AppScopeProvider, type AppAssetResolver, type AppScope } from './app-scope';
import { getXDB, type XDBService } from '../runtime/xdb';
import { readSavedSyncRoom } from '../runtime/xdb-sync-key';
import { openAppView, type AppView } from '../runtime/sync-activity';
import { releaseFilesOf } from '../runtime/file-registry';
import { builtinHelpers } from '../runtime/helpers';
import type { SoftNDocument } from '../parser/ast';
import type { BindingTarget, Expression, TemplateNode } from '../parser/ast';
import type { SoftNRenderContext, SoftNProps } from '../types';
import { parseStatePath } from '../runtime/state-path';
import { debug } from '../runtime/debug';

/**
 * Permission manifests and pre-included path lists are JSON data, but callers
 * commonly construct them inline. Preserve the previous reference while their
 * contents are unchanged so a harmless parent re-render cannot restart the VM.
 */
export function useStructurallyStableValue<T>(value: T): T {
  const serialized = JSON.stringify(value);
  const ref = useRef<{ serialized: string | undefined; value: T }>({ serialized, value });
  if (ref.current.serialized !== serialized) {
    ref.current = { serialized, value };
  }
  return ref.current.value;
}

/**
 * loader/scope-css.ts, once an app with a style block has asked for it: what
 * keeps that app's CSS to the app. Most apps have none, and the web
 * runtime's first load does without it. A load that fails leaves the style
 * block out, not unscoped, and the next app asks again.
 */
let scopeCss: typeof import('./scope-css') | null = null;
let scopeCssLoading: Promise<void> | null = null;
function loadScopeCss(): Promise<void> {
  scopeCssLoading ??= import('./scope-css').then(
    (module) => {
      scopeCss = module;
    },
    () => {
      scopeCssLoading = null;
    }
  );
  return scopeCssLoading;
}

/** Names the apps drawn in this document by, for their CSS (see scope-css.ts). */
let appsNamed = 0;

/**
 * The longest a page's first draw waits for the light on-demand components
 * its first screen names (registry.firstDrawLoads). From a cache they take a
 * few milliseconds; this bounds a slow network's round trip, after which the
 * page is drawn with a placeholder where each still loading goes.
 */
const FIRST_DRAW_WAIT_MS = 300;

/**
 * A phase boundary on the performance timeline, where a profile can read it
 * back. Every phase is `softn:<phase>:start` / `softn:<phase>:end`. Guarded
 * because the renderer also runs under Node and older WebViews.
 */
function perfMark(name: string): void {
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    performance.mark(name);
  }
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
  // A backslash before anything that is not a hex digit is an escape too: the
  // browser reads `u\rl(` as `url(`, `h\ttps:` as `https:` and `@im\port` as
  // `@import`, and the passes below match on the text as written, so each of
  // those reached the network. An escaped backslash is folded to a slash
  // rather than kept, because the URL parser treats `\` as `/` under an
  // http(s) base — `/\host/x` is `//host/x` — and the target test below asks
  // about slashes. A backslash before a newline is a string continuation and
  // is left to mean what it says.
  sanitized = sanitized.replace(/\\([^0-9a-fA-F\r\n\f])/g, (_match, ch: string) =>
    ch === '\\' ? '/' : ch
  );
  // Comments out, each a space as it separates tokens, in one pass that reads
  // strings as strings. The passes below matched "whitespace or a comment"
  // between tokens with a pattern that backtracked: twenty-eight empty
  // comments in a row took a third of a second, forty would have held the
  // page for minutes, and the style block is the bundle author's to write.
  sanitized = stripCssComments(sanitized);
  // Remove @import rules, whatever follows the keyword, to the rule's `;`.
  // CSS needs no whitespace between an at-keyword and the token after it, so
  // `@import"…";` and `@import'…';` are imports too; `@importurl(` is not
  // (that is one at-keyword), and its url() is judged below like any other.
  sanitized = removeCssImports(sanitized, '/* @import removed */');
  // Remove url() values that reference external or dangerous protocols, and
  // the image functions that take their targets as plain strings —
  // `image-set("https://…" 1x)` loads exactly what `url(https://…)` does and
  // used to pass because it contains no `url(`.
  //
  // The matching lives in `rewriteCssResources` because the inline `style={{…}}`
  // path judges the same forms with a different verdict: a style block never
  // gets a remote resource, while an inline one is held to the bundle's
  // network permission.
  //
  // `isRemoteUrl` is the judge the other sinks use: it drops the characters a
  // browser ignores before reading a scheme and folds backslashes, so a
  // target the escape pass above did not fully flatten is still seen for what
  // it is. The pattern beside it keeps the schemes a style block has never
  // been allowed — `data:`, `blob:` and `javascript:` carry no host, so the
  // remote test does not speak to them.
  sanitized = rewriteCssResources(
    sanitized,
    (target) =>
      isRemoteUrl(target) ||
      /^\s*(?:https?:|data:|javascript:|blob:|ftp:|\/\/|\\)/i.test(target)
  );
  // Remove expression() (IE) — a code execution vector.
  sanitized = removeCssFunction(sanitized, 'expression', '/* expression removed */');
  // Match legacy properties at declaration boundaries, not the suffix of
  // scroll-behavior / overscroll-behavior. Preserve rule braces and separators:
  // a final declaration need not have a semicolon, even inside a media query.
  sanitized = sanitized.replace(
    /((?:^|[;{])\s*)(-moz-binding|behavior)\s*:[^;{}]*/gi,
    '$1/* $2 removed */'
  );
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
   * A link to another page of the app was clicked, `<a href="about.html">`:
   * true when the host shows that page itself, and the browser is not sent
   * there. See SoftNRenderContext.followLink.
   */
  onLink?: (href: string) => boolean;

  /**
   * The page's code set `document.title`. A host that owns the window (the
   * standalone runtime) shows it; an editor's preview does not.
   */
  onTitleChange?: (title: string) => void;

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
   * The bundle's `config.execution` from its manifest. `'worker'` runs the
   * script in a dedicated thread when nothing in it needs the main thread
   * synchronously; see the decision where the runtime is created.
   */
  executionPreference?: 'worker' | 'main';

  /**
   * Where the script's `softn.storage.*` calls go: the storage endpoint of
   * this app in the directory that published it. Absent for an app opened
   * from a file, which then has no server storage.
   */
  storageEndpoint?: string;
  /** Calls only the backend selected by the trusted host. */
  backendCall?: (action: string, input: Record<string, unknown>) => Promise<unknown>;
  /**
   * Where `softn.net.fetch` goes instead of the browser's `fetch`. Forwarded
   * to the script runtime; see `ScriptRuntimeOptions.netFetchHandler` for what
   * supplying one means, including that it takes the capability's checks with
   * it. Absent, the network behaves exactly as it always has.
   */
  netFetchHandler?: NetFetchHandler;
  /**
   * The app's logic when it is written in Python, as `composeBundleSource`
   * found it. Spread in with the rest of the composed bundle; absent for every
   * bundle whose logic is JavaScript, which is every bundle that has shipped.
   *
   * Its presence also decides the thread: see the note beside `effectiveMode`.
   */
  python?: PythonProject;

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

  /**
   * Hand React, for every part of the page that comes out the same as it did
   * last time, the element it already has, so the components there are not
   * run again (see renderer/reuse.ts). On unless set to false, which draws
   * every element afresh on every change, as the renderer did before.
   */
  reuseElements?: boolean;

  /**
   * Whether the host is showing this app. softn-web keeps every open tab
   * mounted and toggles them with `display`, so a renderer cannot tell from
   * its own tree whether it is on screen. Published to the components below;
   * defaults to true for a host that shows one app at a time.
   */
  active?: boolean;

  /**
   * How this app's markup reaches the files in its bundle, published to the
   * components below so a loader can resolve paths against the bundle rather
   * than against whichever app rendered last.
   */
  assetResolver?: AppAssetResolver;

  /**
   * The store this app's data block already subscribed to. SoftNWithXDB
   * passes the instance useDataBlock gave it, so the data the markup reads
   * and the store its forms write are one object by construction rather than
   * two lookups that happen to agree. Defaults to the store for `appId`.
   */
  xdb?: XDBService;
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
    // A default is an expression too: `(row, label = title(row)) => …`.
    if (expr.patterns?.some((param) => targetHasCall(param))) return true;
    return typeof expr.body === 'string' ? false : expressionHasCall(expr.body);
  }
  if (expr.type === 'ObjectExpression') {
    return expr.properties.some((p) =>
      p.type === 'SpreadElement'
        ? expressionHasCall(p.argument)
        : expressionHasCall(p.computedKey) || expressionHasCall(p.value)
    );
  }
  if (expr.type === 'UpdateExpression') {
    return expressionHasCall(expr.argument);
  }
  if (expr.type === 'NewExpression') {
    // Constructing a Date calls nothing of the script's; its arguments might.
    return expr.arguments.some((a) => expressionHasCall(a));
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

/** Whether a default anywhere in a parameter's pattern makes a call. */
function targetHasCall(target: BindingTarget): boolean {
  if (expressionHasCall(target.default)) return true;
  const pattern = target.pattern;
  if (pattern.type === 'ArrayPattern') return pattern.elements.some(targetHasCall);
  if (pattern.type === 'ObjectPattern') return pattern.properties.some((property) => targetHasCall(property.value));
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
 * A refused save, in words. The browser's own name for the cause is kept —
 * a person who searches for "QuotaExceededError" finds the answer — and the
 * advice is the one thing that helps in every case: get the data out.
 */
function describePersistenceFailure(failure: PersistenceFailure): string {
  const cause = failure.error.name && failure.error.name !== 'Error' ? failure.error.name : 'the browser refused it';
  const what =
    failure.operation === 'clear'
      ? 'could not clear its saved data'
      : failure.operation === 'removeItem'
        ? `could not remove its saved "${failure.key}"`
        : `could not save "${failure.key}"`;
  return `This app ${what} (${cause}). What it saved before is unchanged; free up storage in the browser, or export the app's data before going on.`;
}

/** The bar that carries a refused save to the person, until they dismiss it. */
function PersistenceNotice({
  message,
  onDismiss,
  kind = 'persistence',
}: {
  message: string;
  onDismiss: () => void;
  /** `alert`: what the page's `alert()` said, which the person answers. */
  kind?: 'persistence' | 'alert';
}): React.ReactElement {
  return (
    <div
      role={kind === 'alert' ? 'alertdialog' : 'status'}
      aria-live={kind === 'alert' ? 'assertive' : 'polite'}
      data-softn-notice={kind}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        padding: '0.5rem 0.75rem',
        backgroundColor: '#fffbeb',
        borderBottom: '1px solid #fcd34d',
        color: '#78350f',
        fontSize: '0.875rem',
        lineHeight: 1.4,
      }}
    >
      <span style={{ flex: 1 }}>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        style={{
          border: '1px solid #fcd34d',
          background: 'transparent',
          color: 'inherit',
          borderRadius: '0.25rem',
          padding: '0.2rem 0.5rem',
          cursor: 'pointer',
        }}
      >
        {kind === 'alert' ? 'OK' : 'Dismiss'}
      </button>
    </div>
  );
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
  onLink,
  onTitleChange,
  importResolver,
  logicBasePath,
  preIncludedLogicPaths,
  executionPreference,
  storageEndpoint,
  backendCall,
  netFetchHandler,
  python,
  permissionConfig,
  scriptExecutionMode = 'worker',
  resumeSavedSyncRoom = false,
  bundleFileProvider,
  stateRef,
  reuseElements = true,
  active = true,
  assetResolver,
  xdb: xdbProp,
}: SoftNRendererProps): React.ReactElement | null {
  // One for the life of the mount: what the last drawing made, kept so the
  // next can hand React the same elements where nothing came out different.
  const renderCacheRef = useRef<SoftNRenderCache | null>(null);
  if (reuseElements && !renderCacheRef.current) renderCacheRef.current = createRenderCache();
  const renderCache = reuseElements ? (renderCacheRef.current ?? undefined) : undefined;
  const runtimePermissions = useStructurallyStableValue(permissions);
  const runtimePermissionConfig = useStructurallyStableValue(permissionConfig);
  const runtimePython = useStructurallyStableValue(python);
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
  // A save the browser refused, in words for the person using the app. The
  // script is told by an exception; without this the person is told by
  // nothing, and finds out when they come back for the save.
  const [persistenceNotice, setPersistenceNotice] = useState<string | null>(null);
  // What the page's `alert()` last said, shown in the app as the app's.
  const [appAlert, setAppAlert] = useState<string | null>(null);
  const showAlert = useCallback((message: string) => setAppAlert(message), []);
  // Why a page written for a browser has no script running, said on the page.
  const [scriptNotice, setScriptNotice] = useState<string | null>(null);
  // The document the page's code is given, once its code is found to use one.
  const [documentShell, setDocumentShell] = useState<DocumentShell | null>(null);
  // Whether the page's code took the document: it is told the page is ready then.
  const [shellActive, setShellActive] = useState(false);

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
  const containerRef = useRef<HTMLDivElement | null>(null);
  // The container as state too, for what has to follow it: it is drawn after
  // the first render where the page is still loading, and drawn anew when
  // `currentPage` changes, since it is keyed by it.
  const [containerElement, setContainerElement] = useState<HTMLDivElement | null>(null);
  const attachContainer = useCallback((element: HTMLDivElement | null) => {
    containerRef.current = element;
    setContainerElement(element);
  }, []);

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
  // Where the app's files are, read as it is now: a page's fetch('data.json')
  // asks it (bundle.read), and a new function each render must not restart the app.
  const assetResolverRef = useRef(assetResolver);
  assetResolverRef.current = assetResolver;
  const readAsset = useCallback((path: string) => assetResolverRef.current?.(path) ?? '', []);

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

  // The store the components below write to. Storage is namespaced per app,
  // and `<SmartForm collection="…">` is an ordinary component well below here
  // with no appId of its own; it must land on the same store this app's own
  // logic uses, or it writes records the app can never read. This used to be
  // done by pointing a module-level fallback at `appId` during render, which
  // named whichever app had rendered last — with every softn-web tab mounted
  // at once, a re-render of tab B between a form handler's await and its
  // resume sent tab A's record into B's store. Published as context instead
  // (see app-scope.tsx); the instance is memoised per appId so a re-render
  // cannot move it, and the provider goes on at the render below.
  const scopedXdb = useMemo(() => xdbProp ?? getXDB(appId), [xdbProp, appId]);

  // Peer-to-peer sync is for the app on screen (sync-activity.ts): its rooms
  // wait while the host shows another of its apps, rejoin when it shows this
  // one again, and close with it.
  const appViewRef = useRef<AppView | null>(null);
  const shownRef = useRef(active);
  shownRef.current = active;
  useEffect(() => {
    const view = openAppView(appId, shownRef.current);
    appViewRef.current = view;
    return () => {
      appViewRef.current = null;
      view.close();
    };
  }, [appId]);
  useEffect(() => {
    appViewRef.current?.setShown(active);
  }, [active]);

  // Parse source when provided directly
  useEffect(() => {
    // Per-invocation stale flag — prevents React Strict Mode double-mount from
    // allowing the first mount's async loadScript callback to run after cleanup.
    let stale = false;
    // A refused save belonged to the runtime being replaced.
    setPersistenceNotice(null);
    setScriptNotice(null);

    if (resolvedSource) {
      // Capture scroll/focus before re-parsing for hot reload
      captureScrollAndFocus();

      try {
        // Through the cache: SoftNWithXDB above has just parsed this same
        // string to find its data block, and hot reload hands the same source
        // back for every save that did not change it. A hit is a Map lookup
        // and still carries the marks, so a profile shows a shared parse as a
        // near-zero phase rather than a missing one. Only the document is
        // shared — the VM, its subscriptions and the permissions are made
        // below, per instance, from what the document says.
        perfMark('softn:parse:start');
        let doc: SoftNDocument;
        try {
          doc = parseCached(resolvedSource);
        } finally {
          perfMark('softn:parse:end');
        }

        // What the first screen renders is known now, and the VM below takes
        // a while to come up: fetch those components' feature modules in the
        // meantime rather than on first render. Only unconditional tags —
        // a component behind a condition is a later route, and its download
        // is deferred until it renders (see document-tags.ts). Never awaited:
        // a failed fetch is reported where the component renders.
        perfMark('softn:component-preload:start');
        const firstScreen = collectFirstScreenTags(doc);
        const registry = getDefaultRegistry();
        void registry.preload(firstScreen).finally(() => perfMark('softn:component-preload:end'));
        // The light on-demand components the first screen draws (a Select,
        // Tabs, a Table): drawn before its chunk had arrived, each would stand
        // as a placeholder, and a wrapper among them would hide what it holds.
        // The first draw waits for them below; null when there are none.
        const firstDraw = registry.firstDrawLoads(firstScreen);
        // Written down for the app's next open, which a host can start them
        // for before it has the page (first-draw-memory.ts).
        if (appId) rememberFirstDraw(appId, registry.firstDrawNames(firstScreen));

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
        // A page with handlers written for a browser runs them in its document,
        // with code of its own or none.
        const browserHandlers = logicEngineIsSandboxed() && hasPageHandlers(doc.template);
        const codeBlock = doc.script || doc.logic || (browserHandlers ? { type: 'LogicBlock' as const, code: '', loc: doc.loc } : undefined);

        // Which state variables the markup can actually read. Derived here
        // because this is where the parsed document lives; the runtime only
        // ever sees the code block.
        const observedStateNames = collectObservedStateNames(doc) ?? undefined;
        // And which names it could call while it is drawn: a function among
        // them reads state for the page, whether the markup names it or not.
        const drawnNames = collectDrawnNames(doc) ?? undefined;

        // Set when the page is to be drawn from its document from the start.
        let earlyShell: Promise<void> | null = null;
        // What the page calls before the script has loaded (declared-functions.ts).
        let standIns: Record<string, (...args: unknown[]) => unknown> = {};
        // Whether the script's own functions are in the state: a first draw
        // that waited (for the document, or for the first screen's
        // components) can come after them, and must not put the stand-ins
        // back over them.
        let scriptLanded = false;

        if (codeBlock && !scriptInitializedRef.current) {
          scriptInitializedRef.current = true;

          // The page's HTML as the document its code is given, if the code
          // turns out to use one: the runtime decides as it compiles, and only
          // then is the document made and its code loaded (see
          // DocumentShellRequest). The page is drawn from it from then on.
          let documentShell: DocumentShell | null = null;
          let making: Promise<DocumentShell> | null = null;
          const shellRequest: DocumentShellRequest = {
            create: () => (making ??= (async () => {
              const { DocumentShell: Shell } = await import('../document-shell/host');
              const made = new Shell(
                doc.template,
                shellOwnsTag,
                doc.title,
                typeof window === 'undefined' ? undefined : window.location.href
              );
              made.onTitle = (title) => onTitleChangeRef.current?.(title);
              // `location.href = 'about.html'` is a link the code follows: shown
              // in the app where the host shows the app's pages, and otherwise
              // followed on the same site where the host follows links at all.
              // Never to another site: the code cannot send the person there.
              made.onNavigate = (href) => {
                if (onLinkRef.current?.(href) === true) return;
                if (!onLinkRef.current || typeof window === 'undefined') {
                  console.warn(`[SoftN] The page's code asked to go to ${href}, and this host shows no other page.`);
                  return;
                }
                const target = sameSiteAddress(href, window.document.baseURI, window.location.origin);
                if (target === null) {
                  console.warn(`[SoftN] The page's code asked to go to ${href}, which is not a page of this site; only a link the person clicks goes elsewhere.`);
                  return;
                }
                window.location.assign(target);
              };
              documentShell = made;
              return made;
            })()),
          };

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
            // State only a drawn function reads moved in the engine: the page
            // holds no copy of it, so it is drawn again with what it holds.
            redraw: () => {
              if (!mountedRef.current || stale) return;
              setState((prev) => ({ ...prev, componentState: { ...prev.componentState } }));
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
          let hasHardIncompat = false;
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
              hasHardIncompat = true;
              effectiveMode = 'main';
              debug(
                '[SoftN] Worker mode fallback to main-thread runtime:',
                hardIncompat.join('; ')
              );
            } else if (requiresSyncMain || hasHostBridgeIncompat) {
              effectiveMode = 'hybrid-worker';
              debug('[SoftN] Worker hybrid mode enabled:', incompat.join('; '));
            }
          }

          // Off-main-thread execution. The script runs in a dedicated worker and
          // every script function the template binds returns a promise; what
          // that buys is the main thread — an emulator that costs more than a
          // display frame to advance no longer blocks the frame it is drawn in.
          // The worker has the storage, `softn.*` and window-event bridges, so
          // the only things that keep a script on this thread are the ones the
          // hybrid mode exists for: computed `$:` declarations and call
          // expressions in the template, both of which need an answer before
          // the next line. A bundle asks with `config.execution: "worker"` in
          // its manifest; a harness can ask with `?exec=worker` — read from the
          // URL if the shell has not rewritten it yet, else from a global set
          // before the app loaded. Functions the host injects into the script
          // are handed over as the same snapshot of getter values the
          // main-thread runtime compiles them into.
          const execParam =
            (typeof location !== 'undefined'
              ? new URLSearchParams(location.search).get('exec')
              : null) ??
            ((globalThis as unknown as Record<string, unknown>).__softnExec as string | undefined) ??
            null;
          const wantsWorker =
            scriptExecutionMode === 'worker' &&
            (execParam === 'worker' || executionPreference === 'worker');
          // `?exec=main` keeps the ordinary path but still installs the hook, so
          // both sides of a measurement drive the script the same way.
          const spikeHook = execParam !== null;
          let forceWorker = false;
          if (wantsWorker) {
            if (hasHardIncompat || requiresSyncMain) {
              debug(
                '[SoftN] Worker execution requested but the script needs the main thread: synchronous evaluation'
              );
            } else {
              forceWorker = true;
              effectiveMode = 'worker';
              debug(
                `[SoftN] Worker execution ${execParam === 'worker' ? 'forced by ?exec=worker' : 'requested by the manifest'}`
              );
            }
          }

          // An engine that exists only on this thread overrides all of the
          // above. The Worker runtime names the ZIPP adapter itself — a second
          // engine is not reachable from it, and an engine built on the host
          // document's own JavaScript could not run there anyway — so a bundle
          // asking for a worker gets the main thread rather than the wrong
          // engine. ZIPP says nothing, so this is inert for every host today.
          if (logicEngineThreads() === 'main-only' && effectiveMode !== 'main') {
            // Same family as the forceWorker advisory below: the script asked
            // for a worker and is not getting one, and the host should know why.
            console.warn(
              '[SoftN] The configured logic engine runs on the main thread only, so worker execution was not used: no wall-clock interruption and no instance recycling.'
            );
            effectiveMode = 'main';
            forceWorker = false;
          }

          // A Python app runs on this thread, whatever the bundle or a harness
          // asked for. The Worker runtime names the ZIPP JavaScript adapter
          // itself; there is no Python path in it at all, so a worker would
          // refuse the app's own source. Silent because this is not a
          // downgrade a host chose — it is the only thread the app can run on.
          if (runtimePython && effectiveMode !== 'main') {
            effectiveMode = 'main';
            forceWorker = false;
          }

          // A page whose own code asks for the document is drawn from it from
          // its first draw. Drawn plainly first and from the document once the
          // code had loaded, every element on it was drawn twice, and what was
          // typed in between was lost. (Code an import brings in is found as
          // it compiles, and such a page changes over then.)
          if (!forceWorker && !runtimePython && logicEngineIsSandboxed() && (usesDocument(codeBlock.code || '') || browserHandlers)) {
            earlyShell = shellRequest.create().then(
              (made) => {
                if (!stale && mountedRef.current) setDocumentShell(made);
              },
              () => {}
            );
          }

          // From here to the script's top level having run: engine creation,
          // compilation, and the first evaluation, on whichever thread.
          perfMark('softn:vm-init:start');
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
                documentShell: shellRequest,
                browserHandlers,
                assetResolver: readAsset,
                preIncludedLogicPaths: runtimePreIncludedLogicPaths,
                permissionConfig: runtimePermissionConfig,
                storageEndpoint,
                backendCall,
                netFetchHandler,
                onAlert: showAlert,
                pythonProject: runtimePython,
                observedStateNames,
                drawnNames,
                onPersistenceFailure: (failure) => {
                  if (stale || !mountedRef.current) return;
                  setPersistenceNotice(describePersistenceFailure(failure));
                },
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
              // Without it the app's element was never named (key-capture.ts),
              // and its window listeners heard every key and click aimed at
              // the page outside an editable field, the host's own included.
              setAppRoot: (element) => mainRuntime.setAppRoot?.(element),
            };
          } else if (effectiveMode === 'worker' && forceWorker) {
            runtime = createWorkerScriptRuntimeLazily(
              formLogicContext,
              runtimePermissions,
              appId,
              importResolver,
              logicBasePath,
              {
                observedStateNames,
                drawnNames,
                preIncludedLogicPaths: runtimePreIncludedLogicPaths,
                permissionConfig: runtimePermissionConfig,
                storageEndpoint,
                backendCall,
                netFetchHandler,
                onAlert: showAlert,
                bundleFileProvider,
                // The app's own files, for the host calls that read them (a
                // bundled model): a worker-mode app read none before.
                assetResolver: readAsset,
                externalFunctions: runtimeFunctions,
                // A worker that missed its hard deadline has been terminated;
                // the app is shown as failed rather than left frozen.
                onFatal: (err) => {
                  if (stale || !mountedRef.current) return;
                  setState((prev) => ({ ...prev, error: err }));
                  onErrorRef.current?.(err instanceof Error ? err : new Error(String(err)));
                },
                onPersistenceFailure: (failure) => {
                  if (stale || !mountedRef.current) return;
                  setPersistenceNotice(describePersistenceFailure(failure));
                },
              }
            );
          } else if (effectiveMode === 'worker') {
            // Same as hybrid: use main-thread VM for all calls. The WASM engine
            // is fast enough to run everything on the main thread without blocking UI.
            //
            // Lifetime boundary (audit ZP-01): the main thread has NO wall-clock
            // supervisor. The instruction budget is the only interruption, so a
            // native call that never returns wedges the tab, and the shared WASM
            // instance lives for the page (dynamic definitions it retains are
            // reclaimed only by a reload). Hosts that must run untrusted or
            // long-running code choose forceWorker, where the Worker is
            // terminated on the hard deadline and recycled on app switch.
            // Reached by every app that did not ask for a worker (the
            // manifest's `config.execution`, or `?exec=worker`), so it is the
            // ordinary case and not a warning: printed for each app a runtime
            // opened, it told visitors' consoles to set a flag no host can.
            debug(
              '[SoftN] Script on the main thread: the bundle did not ask for a worker (config.execution), so there is no wall-clock interruption and no instance recycling.'
            );
            const mainRuntime = createScriptRuntime(
              formLogicContext,
              runtimePermissions,
              appId,
              importResolver,
              logicBasePath,
              {
                mode: 'main',
                documentShell: shellRequest,
                browserHandlers,
                assetResolver: readAsset,
                preIncludedLogicPaths: runtimePreIncludedLogicPaths,
                permissionConfig: runtimePermissionConfig,
                storageEndpoint,
                backendCall,
                netFetchHandler,
                onAlert: showAlert,
                pythonProject: runtimePython,
                observedStateNames,
                drawnNames,
                onPersistenceFailure: (failure) => {
                  if (stale || !mountedRef.current) return;
                  setPersistenceNotice(describePersistenceFailure(failure));
                },
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
              // As in the hybrid handle above: SoftN Web's default mode.
              setAppRoot: (element) => mainRuntime.setAppRoot?.(element),
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
                documentShell: shellRequest,
                browserHandlers,
                assetResolver: readAsset,
                preIncludedLogicPaths: runtimePreIncludedLogicPaths,
                permissionConfig: runtimePermissionConfig,
                storageEndpoint,
                backendCall,
                netFetchHandler,
                onAlert: showAlert,
                pythonProject: runtimePython,
                observedStateNames,
                drawnNames,
                onPersistenceFailure: (failure) => {
                  if (stale || !mountedRef.current) return;
                  setPersistenceNotice(describePersistenceFailure(failure));
                },
              },
              bundleFileProvider,
              runtimeFunctions
            );
          }
          scriptRuntimeRef.current = runtime;

          // A tap before the script has loaded — right after the app opens, or
          // right after Allow reloads it — waits for it rather than finding no
          // function; one made in a runtime that was replaced is let go.
          let scriptArrived: (functions: Record<string, (...args: unknown[]) => unknown>) => void = () => {};
          const arrived = new Promise<Record<string, (...args: unknown[]) => unknown>>((resolve) => {
            scriptArrived = resolve;
          });
          standIns = standInFunctions(declaredFunctionNames(codeBlock.code || ''), arrived);

          // Load the script in the VM (async — compiles, runs, extracts state + functions)
          runtime
            .loadScript(codeBlock)
            // Before the handlers, so the phase ends when the VM is up — not
            // after the React work its result starts.
            .finally(() => perfMark('softn:vm-init:end'))
            .then((result) => {
              scriptArrived(stale || !mountedRef.current ? {} : result.functions);
              if (stale || !mountedRef.current) return;

              debug('[SoftNRenderer] Script loaded successfully (VM)');
              debug('[SoftNRenderer] Functions loaded:', Object.keys(result.functions));
              debug(
                '[SoftNRenderer] Sync functions loaded:',
                Object.keys(result.syncFunctions)
              );
              debug('[SoftNRenderer] Initial state:', result.state);

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

              // A page whose code uses the document is drawn from it from now on.
              const madeShell = documentShell as DocumentShell | null;
              if (madeShell?.active) {
                setDocumentShell(madeShell);
                setShellActive(true);
              }

              // Merge script state into componentState and set functions
              scriptLanded = true;
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
                  const savedRoom = readSavedSyncRoom(appId);
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
              scriptArrived({});
              if (stale || !mountedRef.current) return;
              console.error('[SoftN] Error loading script:', err);
              const scriptError = err instanceof Error ? err : new Error(String(err));
              if (browserHandlers || usesDocument(codeBlock.code || '')) {
                // Code written for a browser: as in a browser, the page stays,
                // and only its script stopped. The page is drawn as written,
                // and what stopped it is said on it.
                setScriptNotice(`This page's script stopped: ${scriptError.message}`);
                setState((prev) => ({ ...prev, loading: false }));
              } else {
                setState((prev) => ({
                  ...prev,
                  error: scriptError,
                  loading: false,
                }));
              }
              // Told to the host as a markup error is: a host that reports
              // through onError (FormLogic's frame does) heard of a page that
              // would not parse, and of no logic that would not compile.
              onErrorRef.current?.(scriptError);
            });
        }

        // Set the document immediately (functions/state arrive asynchronously via loadScript).
        // Replace old script functions so no stale closure calls a cleaned-up
        // runtime's vmEngine (which is null) during the gap before loadScript
        // resolves: with stand-ins that wait for the new one.
        // A page drawn from its document waits the moment it takes to make it.
        const showDocument = () => {
          // A first draw that waited may come after the script: its functions
          // stay, and the stand-ins are only for a draw that comes first.
          const waiting = Boolean(codeBlock) && !scriptLanded;
          setState((prev) => ({
            ...prev,
            document: doc,
            loading: false,
            error: null,
            scriptFunctions: waiting ? standIns : prev.scriptFunctions,
            scriptSyncFunctions: waiting ? {} : prev.scriptSyncFunctions,
            scriptComputed: waiting ? {} : prev.scriptComputed,
          }));
          onLoadRef.current?.(doc);
        };
        // Started now, so the page is hidden for as little as can be.
        if (doc.style?.content && !scopeCss) void loadScopeCss();
        // What the first draw waits for, if anything: the document, for a page
        // drawn from it, and the first screen's light components, a moment
        // from the cache and no more than FIRST_DRAW_WAIT_MS from a slow
        // network, after which the page is drawn as it stands.
        const holds: Promise<unknown>[] = [];
        if (earlyShell) holds.push(earlyShell as Promise<void>);
        if (firstDraw) holds.push(Promise.race([firstDraw, new Promise((resolve) => setTimeout(resolve, FIRST_DRAW_WAIT_MS))]));
        if (holds.length > 0) {
          void Promise.all(holds)
            .then(() => {
              if (!stale && mountedRef.current) showDocument();
            })
            // What the immediate draw's catch below does: a host's onLoad that
            // throws is the page's error, not an unhandled rejection.
            .catch((err: unknown) => {
              if (stale || !mountedRef.current) return;
              const error = err instanceof Error ? err : new Error(String(err));
              setState((prev) => ({ ...prev, document: null, loading: false, error }));
              onErrorRef.current?.(error);
            });
        } else {
          showDocument();
        }
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
        // Let go of it too: a source that has no code next (an edit that
        // removed the page's <logic>) runs no runtime of its own, and the
        // effects below would hand the closed one the new page's element,
        // which put it back in key-capture's map for the page's life.
        scriptRuntimeRef.current = null;
      }
      if (syncPollRef.current) {
        clearInterval(syncPollRef.current);
        syncPollRef.current = null;
      }

      // Allow re-initialization on next mount (React Strict Mode double-mount)
      scriptInitializedRef.current = false;
      setDocumentShell(null);
      setShellActive(false);
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
    storageEndpoint,
    backendCall,
    netFetchHandler,
    // Stable: made once with useCallback.
    showAlert,
    readAsset,
    runtimePython,
    runtimePermissions,
    runtimePreIncludedLogicPaths,
    runtimeFunctions,
    scriptExecutionMode,
    // Chooses worker or main thread alongside scriptExecutionMode, so a change
    // to it has to rebuild the runtime the same way.
    executionPreference,
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

  // What a handler wrote that React has not drawn yet, handed to the logic now
  // so that a function the same handler calls next reads it (see
  // SoftNRenderContext.shareState). React's own update follows as above.
  const shareComponentState = useCallback((changes: Record<string, unknown>) => {
    scriptRuntimeRef.current?.updateContext(changes);
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
        debug(`[SoftNRenderer] initialState change detected: ${key}`, {
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
  // The host's answer for a link, read when the link is clicked: a host that
  // passes a fresh function each render does not redraw the page for it.
  const onLinkRef = useRef(onLink);
  onLinkRef.current = onLink;
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  const followLink = useCallback((href: string) => onLinkRef.current?.(href) === true, []);

  // What the app's window listeners hear is what is aimed at the element it
  // is drawn in (runtime/key-capture.ts).
  useEffect(() => {
    scriptRuntimeRef.current?.setAppRoot?.(containerElement);
  }, [containerElement, scriptLoaded, state.document]);

  // What the page's code put on its html and body, drawn on the app's root.
  const rootVersion = useSyncExternalStore(
    useCallback(
      (onChange: () => void) => {
        if (!documentShell) return () => {};
        const offBody = documentShell.subscribe(documentShell.bodyId, onChange);
        const offHtml = documentShell.subscribe(SHELL_HTML_ID, onChange);
        return () => {
          offBody();
          offHtml();
        };
      },
      [documentShell]
    ),
    () => (documentShell ? documentShell.version(documentShell.bodyId) * 65536 + documentShell.version(SHELL_HTML_ID) : 0),
    () => 0
  );

  // The app's style block, kept to the element the app is drawn in.
  const [appName] = useState(() => `a${(++appsNamed).toString(36)}`);
  const [styleScoper, setStyleScoper] = useState<'loading' | 'ready' | 'failed'>(scopeCss ? 'ready' : 'loading');
  const styleContent = state.document?.style?.content;
  useEffect(() => {
    if (!styleContent) return;
    if (scopeCss) {
      setStyleScoper('ready');
      return;
    }
    let live = true;
    void loadScopeCss().then(() => {
      if (live) setStyleScoper(scopeCss ? 'ready' : 'failed');
    });
    return () => {
      live = false;
    };
  }, [styleContent]);
  const scopedStyle = useMemo(
    () =>
      styleContent && styleScoper === 'ready' && scopeCss
        ? scopeCss.scopeAppCss(showBundleFilesInStyles(sanitizeBundleCSS(styleContent), assetResolver), appName)
        : null,
    [styleContent, assetResolver, appName, styleScoper]
  );

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
      shareState: shareComponentState,
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
      // What the markup may fetch, judged by the bundle's own declaration. A
      // host that supplied no config is not enforcing; see egress-policy.ts.
      egress: runtimePermissionConfig ?? null,
      followLink,
      renderCache,
      ...(documentShell ? { documentShell } : {}),
      ...(scopedStyle?.names ? { appStyleNames: scopedStyle.names } : {}),
    };
  }, [
    followLink,
    documentShell,
    scopedStyle,
    state.componentState,
    setComponentState,
    shareComponentState,
    initialState,
    initialData,
    componentProps,
    computedValues,
    stableSyncFunctions,
    stableAsyncFunctions,
    scriptLoaded,
    state.scriptComputed,
    runtimePermissionConfig,
    renderCache,
  ]);

  // What the device components are allowed: which capabilities the bundle
  // declared and the user granted, and whether the bar is still unanswered.
  // Published once per config, so a re-render does not re-publish an equal
  // state and restart every device below.
  const capabilityState = useMemo<CapabilityState>(
    () => ({
      consentPending: runtimePermissionConfig?.consentPending === true,
      // A config with no `permissions` key declared nothing; only the absence
      // of a config altogether means the host is not enforcing.
      permissions: runtimePermissionConfig
        ? ((runtimePermissionConfig.permissions ?? {}) as CapabilityState['permissions'])
        : null,
    }),
    [runtimePermissionConfig]
  );

  // Which app the components below are in. One object per change of its
  // parts, for the same reason as the capability state above.
  //
  // A component that switches pages (NavItem's `page`) sets the state the
  // app keeps its page in: `currentPage`, which the host's own routing reads
  // (onPageChange), or `page`, as Studio's projects write it.
  const pageKey =
    typeof state.componentState.currentPage === 'string'
      ? 'currentPage'
      : typeof state.componentState.page === 'string'
        ? 'page'
        : null;
  const currentPage = pageKey ? (state.componentState[pageKey] as string) : undefined;
  const showPage = useCallback(
    (name: string): boolean => {
      if (!pageKey) return false;
      setComponentState(pageKey, name);
      return true;
    },
    [pageKey, setComponentState]
  );
  // What the app's components register of the files the person picks (a
  // FileChooser's) is released when the app closes, or when this renderer
  // takes another app; it was kept for the page's life.
  const filesOwner = useMemo(() => ({ appId }), [appId]);
  useEffect(() => () => releaseFilesOf(filesOwner), [filesOwner]);
  const appScope = useMemo<AppScope>(
    () => ({
      appId,
      xdb: scopedXdb,
      active,
      assets: assetResolver,
      clipboard: runtimePermissions?.clipboard !== false,
      followLink,
      filesOwner,
      ...(pageKey ? { currentPage, showPage } : {}),
    }),
    [appId, scopedXdb, active, assetResolver, runtimePermissions, followLink, filesOwner, pageKey, currentPage, showPage]
  );

  // The page has been drawn from the document: the browser's events on it go
  // to the page's code, and the code is told the page is ready
  // (DOMContentLoaded, then load), as a browser tells it after reading it.
  //
  // It follows the container: one that is not drawn yet when the code turns
  // out to use the document, or one drawn anew for another page, is where
  // the events are. Ready is said once; saying it again does nothing.
  useEffect(() => {
    if (!documentShell || !containerElement) return;
    documentShell.connect(containerElement);
    return () => documentShell.disconnect();
  }, [documentShell, containerElement]);
  useEffect(() => {
    if (documentShell && containerElement && shellActive) documentShell.ready();
  }, [documentShell, containerElement, shellActive]);

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
    // What the page's code put on its html and body (a theme class, a CSS
    // variable), checked as any element's attributes are.
    const root = documentShell && rootVersion >= 0 ? rootProps(documentShell.rootAttributes(), context, registry) : {};
    const rootStyle = root.style && typeof root.style === 'object' ? (root.style as React.CSSProperties) : null;

    return (
      // Both providers sit outside the keyed container, so a page change does
      // not tear them down with the page. Components below read these instead
      // of props: they are instantiated from the .ui template, so a prop
      // would have to be threaded through every component in the registry.
      //
      // The scope says which app they are in — the store a <SmartForm> saves
      // to, whether the tab is on screen, where its assets are — and it is
      // the only thing that does: no global says it any more.
      //
      // <Camera>, <QRReader> and <Microphone> open the hardware from their own
      // effects and permission.json does not cover them, so what the
      // capability provider publishes — consent state and the granted
      // capability list — is the only thing standing between an entry page
      // and the device.
      <AppScopeProvider value={appScope}>
      <CapabilityProvider value={capabilityState}>
      {/* The host's notices sit above the app, outside what its CSS reaches:
          inside it, `[data-softn-notice] { display: none }` hid the warning
          that the app's data could not be saved. The app's page fills what
          they leave. */}
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {persistenceNotice && (
        <PersistenceNotice
          message={persistenceNotice}
          onDismiss={() => setPersistenceNotice(null)}
        />
      )}
      {appAlert !== null && (
        <PersistenceNotice kind="alert" message={appAlert} onDismiss={() => setAppAlert(null)} />
      )}
      {scriptNotice !== null && (
        <PersistenceNotice message={scriptNotice} onDismiss={() => setScriptNotice(null)} />
      )}
      {/* What the app's CSS is kept inside (scope-css.ts). It draws no box of
          its own, and holds nothing but the page: the page's element is the
          app's `html` and `body`, and has nothing beside it to reach. */}
      <div data-softn-app={appName} style={{ display: 'contents' }}>
      <div
        {...root}
        ref={attachContainer}
        key={`softn-container-${stateKey}`}
        data-softn-page={stateKey}
        // Not seen without its style block, for the moment it takes to load
        // what keeps that block to the app. (A load that failed shows the
        // page without the block, rather than not at all.)
        style={
          styleContent && !scopedStyle && styleScoper === 'loading'
            ? { flex: '1 1 0%', minHeight: 0, ...rootStyle, visibility: 'hidden' }
            : { flex: '1 1 0%', minHeight: 0, ...rootStyle }
        }
      >
        {scopedStyle && <style dangerouslySetInnerHTML={{ __html: scopedStyle.css }} />}
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
      </div>
      </div>
      </CapabilityProvider>
      </AppScopeProvider>
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
        // The SoftNRenderer that SoftNWithXDB renders from this source asks
        // the cache for the same string and gets this very object back.
        const doc = parseCached(source);
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
