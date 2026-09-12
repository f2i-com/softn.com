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
export type BlockComponentType = (typeof BLOCK_COMPONENT_TYPES)[number];

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
  dropIndicator: { parentId: string; index: number } | null;
  imports?: UIImport[]; // Imports from the current file
}

// History state for undo/redo
export interface HistoryEntry {
  elements: Map<string, CanvasElement>;
  rootId: string;
  timestamp: number;
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
  content: string; // Raw .logic source
  imports: LogicImport[]; // Parsed imports
  exports: string[]; // Detected exports
}

// Import from another UI file
export interface UIImport {
  name: string; // "Header"
  source: string; // "./components/Header.ui"
}

// Import from another logic file
export interface LogicImport {
  names: string[]; // ["validateEmail", "formatPhone"]
  source: string; // "./utils/validation.logic"
}
