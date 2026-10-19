/**
 * SoftN Type Definitions
 *
 * Core types used across the SoftN engine.
 */

export * from '../parser/ast';
export * from '../parser/token';

/**
 * Props passed to SoftN components at runtime
 */
export interface SoftNProps {
  [key: string]: unknown;
}

/**
 * Event handler type
 */
export type SoftNEventHandler = (...args: unknown[]) => void | Promise<void>;

/**
 * Component registry entry
 */
export interface ComponentEntry {
  name: string;
  component: React.ComponentType<SoftNProps>;
}

/**
 * Runtime state
 */
export interface RuntimeState {
  [key: string]: unknown;
}

/**
 * XDB collection data
 */
export interface XDBRecord {
  id: string;
  collection: string;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  deleted: boolean;
}

/**
 * Collection hook result
 */
export interface UseCollectionResult {
  records: XDBRecord[];
  loading: boolean;
  error: Error | null;
  refresh: () => void;
  create: (data: Record<string, unknown>) => Promise<XDBRecord>;
  update: (id: string, data: Record<string, unknown>) => Promise<XDBRecord>;
  remove: (id: string) => Promise<void>;
}

/**
 * Slot content mapping
 */
export interface SlotContent {
  // Key is slot name, value is the children to render
  [slotName: string]: import('../parser/ast').TemplateNode[];
}

/**
 * SoftN render context
 */
export interface SoftNRenderContext {
  // State from script block
  state: RuntimeState;
  setState: (path: string, value: unknown) => void;
  /**
   * Hand the logic state the page has written and React has not yet drawn.
   * A handler's block body, `{ n = 5; save() }`, calls this between its
   * statements, so the logic function it calls next reads what it wrote.
   * Optional: without it a logic call sees the write once the page is drawn.
   */
  shareState?: (changes: Record<string, unknown>) => void;

  // Data from XDB collections
  data: Record<string, XDBRecord[]>;

  // Props from parent
  props: SoftNProps;

  // Computed values
  computed: Record<string, unknown>;

  // Functions from script block (sync - for template expressions)
  functions: Record<string, (...args: unknown[]) => unknown>;

  // Async functions from script block (for event handlers - track state changes)
  asyncFunctions: Record<string, (...args: unknown[]) => unknown>;

  // Whether the script block has finished loading (suppresses function-not-found warnings during init)
  scriptLoaded?: boolean;

  /**
   * The app's declared capabilities are withheld until the user answers the
   * consent bar, so nothing this render emits may reach another host.
   *
   * Carried on the context rather than read from React context because the
   * renderer is a plain function: it turns markup into elements before any
   * component mounts, which is exactly where an `<img src="https://…">` or an
   * inline `backgroundImage` would otherwise be handed to the browser. It is
   * a per-document value — softn-web mounts every open tab in one realm, and
   * one tab's grant must not speak for another's.
   */
  consentPending?: boolean;

  /**
   * The bundle's permission config, for deciding what the markup may fetch
   * once consent has been answered: a remote `src`, `poster` or inline
   * `url(...)` is egress and needs `net`, to a host `allowed_hosts` permits —
   * the same rule `softn.net.fetch` applies. See runtime/egress-policy.ts.
   * `null` or absent means the host is not enforcing (a preview outside any
   * bundle), which withholds only while `consentPending` is true.
   */
  egress?: import('../runtime/egress-policy').EgressConfig | null;

  /**
   * Follow a link to another page of the app, `<a href="about.html">`, in
   * place: true when the host has taken the link, and the browser does not
   * follow it. A host that runs a bundle answers for the bundle's pages; with
   * none, every link is the browser's, as it always was.
   */
  followLink?: (href: string) => boolean;

  /**
   * The document the page's code is given, when its code uses one: the
   * renderer draws the page's plain HTML from it (document-shell/host.ts).
   */
  documentShell?: import('../document-shell/host').DocumentShellView;

  // Current iteration context (for #each)
  each?: {
    item: unknown;
    index: number;
    key?: string;
  };

  /**
   * The names the template itself has bound where this is being drawn: the
   * variables of the `#each` blocks around it, innermost first. Looked up
   * before `state`, so a loop variable hides a state variable of its name.
   * The renderer makes these; a host does not set it.
   */
  locals?: SoftNLocalScope;

  /**
   * What this mount drew last time, so that what comes out the same is
   * handed to React as the element it already has and its component is not
   * run again. A host makes one with `createRenderCache()` for each mounted
   * document and passes the same one on every render; leaving it out draws
   * every element afresh. See renderer/reuse.ts for what counts as the same.
   */
  renderCache?: import('../renderer/reuse').SoftNRenderCache;

  // Slot content passed from parent component
  slots?: SlotContent;
}

/**
 * One layer of names a template bound: a pass of an `#each`, or a call of an
 * arrow function.
 *
 * A layer rather than a copy of `state` with the names added, which is what
 * this was: every row of a list, and every call of the arrow in
 * `rows.filter(r => …)`, copied each of the app's state variables to add one
 * or two. `names` and `values` are parallel.
 *
 * A pass of a loop over a list that is in the app's state also says where
 * its item lives there, which is what lets `:bind={todo.done}` write the
 * row: `list` is the list's path (`todos`), `position` the item's index or
 * key, and `suffixes[i]` what follows for `names[i]` (`""` for the item
 * itself, `".id"` for a name destructured out of it, `undefined` for a name
 * with no place, such as the index).
 */
export interface SoftNLocalScope {
  readonly names: readonly string[];
  readonly values: readonly unknown[];
  readonly list?: string;
  readonly position?: number | string;
  readonly suffixes?: readonly (string | undefined)[];
  readonly parent?: SoftNLocalScope;
}

/**
 * Compiled SoftN document ready for rendering
 */
export interface CompiledSoftNDocument {
  // Original document
  document: import('../parser/ast').SoftNDocument;

  // Compiled script (VM bytecode)
  compiledScript?: unknown;

  // Parsed CSS
  styles?: string;

  // Resolved imports
  imports: Map<string, CompiledSoftNDocument>;
}
