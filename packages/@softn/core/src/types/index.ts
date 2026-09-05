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

  // Current iteration context (for #each)
  each?: {
    item: unknown;
    index: number;
    key?: string;
  };

  // Slot content passed from parent component
  slots?: SlotContent;
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
