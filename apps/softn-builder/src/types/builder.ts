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
  type: 'one-to-one' | 'one-to-many' | 'many-to-many';
}

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
}

// Logic file
export interface LogicFileState {
  id: string;
  path: string;
  content: string; // Raw FormLogic code
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
