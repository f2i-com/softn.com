/**
 * SoftN Builder TypeScript Types
 */

// Component metadata for the palette
export interface PropSchema {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'color' | 'event' | 'expression' | 'json';
  options?: string[];
  default?: unknown;
  description?: string;
}

export interface ComponentMeta {
  name: string;
  category: ComponentCategory;
  icon: string;
  description: string;
  defaultProps: Record<string, unknown>;
  propSchema: PropSchema[];
  allowChildren: boolean;
  childTypes?: string[];
  /** How many elements the component draws, where it draws no more: a Split has two panes. */
  maxChildren?: number;
  /** Whether it stands in a line of words, as an Icon or a key does (componentRegistry.ts, INLINE_KINDS). */
  inline?: boolean;
  /** Whether the canvas draws the component itself, not a card with its name (componentRegistry.ts, DRAWN_FOR_REAL). */
  drawn?: boolean;
}

export type ComponentCategory =
  | 'Layout'
  | 'Form'
  | 'Display'
  | 'Feedback'
  | 'Navigation'
  | 'Utility'
  | 'Data'
  | 'Charts'
  | 'Editors'
  | 'Smart';

/**
 * The header of a control-flow block held as an element of the visual
 * model.
 *
 * `#if`, `#elseif`, `#else`, `#each` and `#empty` used to be flattened into
 * inline `if=` / `each=` attributes on the block's children, which lost a
 * level whenever blocks nested and dropped `#empty` and `#elseif` branches
 * outright. A block is now an element whose `componentType` is the block
 * keyword (see BLOCK_COMPONENT_TYPES), whose branch is its `children`, and
 * whose header lives here. The alternate branches of an `#if` — `#elseif`
 * and `#else` — and the `#empty` branch of an `#each` are the last children
 * of their block, each holding its own branch.
 */
export interface CanvasBlock {
  kind: 'if' | 'elseif' | 'else' | 'each' | 'empty';
  /** `#if` / `#elseif`: the condition, as expression text. */
  condition?: string;
  /** `#each`: the iterable, as expression text. */
  iterable?: string;
  /** `#each`: the loop variable. */
  itemName?: string;
  /** `#each`: the optional index variable. */
  indexName?: string;
  /** `#each`: the optional `key={…}` expression text. */
  keyExpression?: string;
}

/** `componentType` values that are control-flow blocks rather than components. */
export const BLOCK_COMPONENT_TYPES = ['#if', '#elseif', '#else', '#each', '#empty'] as const;

/**
 * The `componentType` of words that stand beside elements.
 *
 * Words that are all a tag holds are its `children` prop, as they always
 * were. Words with an element among them (`Press <Kbd>S</Kbd> to save`) had
 * no place in the model, and a file with any was edited as source only. Each
 * run of them is now an element of this type whose `children` prop is the
 * text, `{expressions}` included, in its place among its siblings.
 */
export const TEXT_NODE_TYPE = '#text';

/**
 * The tag of the page itself. A page has one, at its root, and it is never
 * dropped, moved or pasted into anything: the palette offered it beside the
 * components, and a second `<App>` went inside the first.
 */
export const PAGE_TYPE = 'App';

/**
 * A comment kept with the element it stands before.
 *
 * The parser drops comments, so the model never saw them and a file with
 * one could not be written back: four in five of the shipped examples were
 * edited as source only, each for the comment on its first line.
 */
export interface CanvasComment {
  /** How it is written: `// text` to the end of the line, or `<!-- text -->`. */
  form: 'line' | 'html';
  text: string;
}

/**
 * Whether a .ui file's visual model can be written back without losing
 * anything the source holds. When it cannot, `reasons` says what — a
 * comment the parser drops, an expression the parser stops reading part
 * way through, text mixed with child elements, a construct the generator
 * cannot print — and the file is edited as source only.
 */
export interface SourceFidelity {
  lossless: boolean;
  reasons: string[];
}

// Canvas element representing a component instance
export interface CanvasElement {
  id: string;
  componentType: string;
  props: Record<string, unknown>;
  events?: Record<string, string>;       // @click → { click: "increment" }
  bindings?: Record<string, string>;     // :bind → { bind: "username" }
  conditionalIf?: string;               // if={condition}
  loopEach?: string;                    // each={items}
  loopAs?: string;                      // as="item, index"
  expressionProps?: string[];           // Prop names that were {expression} syntax
  /** Present when the element is a control-flow block; see CanvasBlock. */
  block?: CanvasBlock;
  /** Comments written directly before the element, in order. */
  leadingComments?: CanvasComment[];
  /**
   * Whether a space stands between this element and the sibling before it
   * on one line (`<b>Total:</b> <span>12</span>`), which the engine draws.
   */
  spaceBefore?: boolean;
  children: string[];
  parentId: string | null;
  position?: { x: number; y: number };
}

// Schema field types
export type FieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'email'
  | 'url'
  | 'select'
  | 'reference';

// Schema field definition
export interface SchemaField {
  id: string;
  name: string;
  type: FieldType;
  required: boolean;
  defaultValue?: unknown;
  options?: string[]; // For select type
  refEntity?: string; // For reference type
}

// Entity (collection) definition
export interface EntityDef {
  id: string;
  name: string;
  alias: string;
  fields: SchemaField[];
  position: { x: number; y: number };
}

// Relationship between entities
export interface RelationshipDef {
  id: string;
  sourceEntityId: string;
  sourceFieldId: string;
  targetEntityId: string;
  type: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';
}

/** An empty sourceFieldId is a diagram-only link unless a new field is requested. */
export type RelationshipDraft = Omit<RelationshipDef, 'id'> & { newFieldName?: string };

// XDB collection definition (updated)
export interface CollectionDef {
  name: string;
  alias: string;
  fields: SchemaField[];
  seedData: Record<string, unknown>[];
  fullRecords?: Record<string, unknown>[]; // Full XDB records with { id, collection, data, ... } structure for preview
}

// Asset file
export interface AssetFile {
  /** Original archive path; app assets need not live under assets/. */
  bundlePath?: string;
  name: string;
  type: string;
  data: Uint8Array;
}

// Project state
export interface ProjectState {
  name: string;
  version: string;
  description: string;
  icon?: string;
  themeMode: 'light' | 'dark' | 'system';
  elements: Map<string, CanvasElement>;
  rootId: string;
  logicSource: string;
  collections: CollectionDef[];
  assets: AssetFile[];
}

/**
 * Where a drag would land: at `index` among what `parentId` holds. With a
 * `side`, it is into an element whose content is its words, before or after
 * them; the words are not an element until something stands beside them,
 * so there is no index to give.
 */
export interface DropIndicator {
  parentId: string;
  index: number;
  side?: 'start' | 'end';
}

// Canvas state for drag-drop
export interface CanvasState {
  elements: Map<string, CanvasElement>;
  rootId: string;
  selectedIds: string[];
  hoveredId: string | null;
  clipboard: CanvasElement[];
  /**
   * Every element the clipboard entries depend on, snapshotted at copy time.
   *
   * paste used to resolve children out of the LIVE element map, which is fine
   * after a copy and destroys the subtree after a cut: by then the originals
   * have been deleted, every child lookup returns undefined, and the pasted
   * element comes back stripped of everything inside it.
   */
  clipboardTree: Map<string, CanvasElement>;
  draggedType: string | null;
  dropTargetId: string | null;
  draggedElementId: string | null;
  dropIndicator: DropIndicator | null;
  imports?: UIImport[]; // Imports from the current file
}

// History state for undo/redo
export interface HistoryEntry {
  elements: Map<string, CanvasElement>;
  rootId: string;
  timestamp: number;
  /**
   * The logic files the step also changed, each with its text in this
   * state. A step is the canvas; one that writes a function into the logic
   * (the panel's "Create" beside a handler) is undone whole only if the
   * file goes back with it.
   */
  logic?: LogicSnapshot[];
}

/**
 * A logic file's text at one moment of the history, and the text the file
 * has to have now for it to be put back. A file that has been written in
 * since the step is not that step's to take back: putting `content` over it
 * would throw away the body just typed into a function the step made.
 */
export interface LogicSnapshot {
  id: string;
  content: string;
  /** What the step left the file as. Absent, the file is put back whatever it holds. */
  expects?: string;
}

export interface HistoryState {
  past: HistoryEntry[];
  future: HistoryEntry[];
  maxSize: number;
}

// Drag item for react-dnd
export interface DragItem {
  type: 'PALETTE_COMPONENT' | 'CANVAS_ELEMENT';
  componentType?: string;
  elementId?: string;
}

// Preview state
export interface PreviewState {
  mode: 'split' | 'preview' | 'code';
  scale: number;
  devicePreset: 'desktop' | 'tablet' | 'mobile' | 'custom';
  customWidth?: number;
  customHeight?: number;
}

// ============================================
// Multi-File Support Types
// ============================================

// File node (file or folder) in the project tree
export interface ProjectFileNode {
  id: string;
  name: string;
  path: string; // Full path: "ui/components/Header.ui"
  type: 'file' | 'folder';
  fileType?: 'ui' | 'logic' | 'asset'; // Only for files
  parentId: string | null;
  children?: string[]; // Only for folders
  isDirty?: boolean;
}

// UI file with canvas state
export interface UIFileState {
  id: string;
  path: string;
  elements: Map<string, CanvasElement>;
  rootId: string;
  logicSrc?: string; // Reference: "./page.logic"
  imports: UIImport[]; // Component imports
  /**
   * The names of the imports the Builder wrote for this page, by a page
   * dropped from the palette. Such an import is in the page while an element
   * uses its name and no longer; one the author wrote is never taken out
   * (utils/pageImports.ts).
   */
  writtenImports?: string[];
  originalSource?: string; // Original source for preview (preserves bindings, events, control flow)
  /**
   * Whether the visual model reproduces `originalSource`; computed from the
   * source on the first visual edit when the loader did not supply it, and
   * dropped whenever the source is edited.
   */
  sourceFidelity?: SourceFidelity;
  /**
   * Set when a visual edit was refused because the file is not lossless:
   * the reasons, so the editor can say why the canvas is not writing this
   * file and that its source is where to edit it.
   */
  visualEditBlocked?: string[];
}

// Logic file
export interface LogicFileState {
  id: string;
  path: string;
  content: string; // Raw source, in the language its name says
}

// Import from another UI file
export interface UIImport {
  name: string; // "Header"
  source: string; // "./components/Header.ui"
}

