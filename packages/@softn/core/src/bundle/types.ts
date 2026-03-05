/**
 * SoftN Bundle Types
 *
 * Type definitions for the .softn bundle format.
 * A .softn bundle is a ZIP archive containing UI, logic, and data files.
 */

// ============================================================================
// Manifest Types
// ============================================================================

/**
 * The manifest.json schema for a .softn bundle
 */
export interface SoftNManifest {
  /** Application name */
  name: string;

  /** Semantic version */
  version: string;

  /** Optional description */
  description?: string;

  /** Optional author information */
  author?: string | AuthorInfo;

  /** Main entry point (typically a .ui file) */
  main: string;

  /** Optional icon path within the bundle */
  icon?: string;

  /** File listings by type */
  files: {
    /** UI template files (.ui) */
    ui?: string[];
    /** Logic script files (.logic) */
    logic?: string[];
    /** Database files (.xdb) */
    xdb?: string[];
    /** Asset files (images, fonts, etc.) */
    assets?: string[];
  };

  /** Named imports for convenience */
  imports?: Record<string, string>;

  /** Application configuration */
  config?: AppConfig;

  /** Dependencies on other .softn bundles */
  dependencies?: Record<string, string>;

  /** Permissions required by the app */
  permissions?: AppPermissions;
}

export interface AuthorInfo {
  name: string;
  email?: string;
  url?: string;
}

export interface AppConfig {
  /** Window configuration for desktop apps */
  window?: {
    width?: number;
    height?: number;
    minWidth?: number;
    minHeight?: number;
    resizable?: boolean;
    title?: string;
  };

  /** Theme configuration */
  theme?: {
    primary?: string;
    mode?: 'light' | 'dark' | 'system';
  };

  /** XDB configuration */
  xdb?: {
    /** Whether to sync with peers */
    sync?: boolean;
    /** Collections to auto-create */
    collections?: string[];
  };

  /** Mobile-specific configuration */
  mobile?: {
    /** Screen orientation preference: portrait, landscape, or auto (default) */
    orientation?: 'portrait' | 'landscape' | 'auto';
  };
}

/**
 * @deprecated Use `PermissionConfig` from `../runtime/formlogic` instead.
 * Kept for backward compatibility with existing manifest.permissions fields.
 */
export interface AppPermissions {
  /** File system access */
  filesystem?: boolean | 'read' | 'write' | 'full';
  /** Network access (fetch, WebSocket, XMLHttpRequest) */
  network?: boolean;
  /** Clipboard access (navigator.clipboard) */
  clipboard?: boolean;
  /** Notification access (Notification API) */
  notifications?: boolean;
  /** Local storage access (localStorage, sessionStorage) */
  storage?: boolean;
  /** Geolocation access */
  geolocation?: boolean;
}

// Re-export PermissionConfig from formlogic runtime
export type { PermissionConfig } from '../runtime/formlogic';

// ============================================================================
// File Types
// ============================================================================

/**
 * Represents a file within a .softn bundle
 */
export interface BundleFile {
  /** Path within the bundle */
  path: string;
  /** File type */
  type: 'ui' | 'logic' | 'xdb' | 'asset' | 'manifest' | 'other';
  /** File content (string for text files, Uint8Array for binary) */
  content: string | Uint8Array;
  /** File size in bytes */
  size: number;
  /** Last modified timestamp */
  modified?: Date;
}

/**
 * A parsed .ui file
 */
export interface UIFile {
  /** File path */
  path: string;
  /** Imports declared in this file */
  imports: UIImport[];
  /** Template content (parsed AST) */
  template: import('../parser/ast').TemplateNode[];
  /** Style content (raw CSS) */
  style?: string;
  /** Component declaration if present */
  component?: import('../parser/ast').ComponentDeclaration;
}

/**
 * A parsed .logic file
 */
export interface LogicFile {
  /** File path */
  path: string;
  /** Imports declared in this file */
  imports: LogicImport[];
  /** Exported state variables */
  exports: {
    state: Record<string, unknown>;
    functions: string[];
    computed: string[];
  };
  /** Raw code content */
  code: string;
}

/**
 * Import declaration in a .ui file
 */
export interface UIImport {
  /** Default import name */
  defaultImport?: string;
  /** Named imports */
  namedImports?: string[];
  /** Source path */
  source: string;
  /** Resolved type of import */
  type: 'ui' | 'logic' | 'external';
}

/**
 * Import declaration in a .logic file
 */
export interface LogicImport {
  /** Default import name */
  defaultImport?: string;
  /** Named imports */
  namedImports?: string[];
  /** Source path */
  source: string;
  /** Resolved type of import */
  type: 'logic' | 'ui' | 'external';
}

// ============================================================================
// Bundle Types
// ============================================================================

/**
 * A loaded .softn bundle (with parsed data)
 */
export interface SoftNBundle {
  /** Bundle manifest */
  manifest: SoftNManifest;
  /** All files in the bundle */
  files: Map<string, BundleFile>;
  /** Parsed UI files */
  uiFiles: Map<string, UIFile>;
  /** Parsed logic files */
  logicFiles: Map<string, LogicFile>;
  /** Bundled XDB data */
  xdbData: Map<string, XDBBundleData>;
}

/**
 * File input for bundle creation
 */
export interface BundleFileInput {
  /** Path within the bundle */
  path: string;
  /** File type */
  type: BundleFile['type'];
  /** File content (string for text, Uint8Array or ArrayBuffer for binary) */
  content: string | Uint8Array | ArrayBuffer;
  /** MIME type */
  mimeType?: string;
}

/**
 * Input for creating a .softn bundle (simpler format)
 */
export interface SoftNBundleInput {
  /** Bundle manifest */
  manifest: SoftNManifest;
  /** Files to include in the bundle */
  files: BundleFileInput[];
}

/**
 * XDB data bundled within the app
 */
export interface XDBBundleData {
  /** Collection name */
  collection: string;
  /** Records in the collection */
  records: Array<{
    id: string;
    data: Record<string, unknown>;
    created_at: string;
    updated_at: string;
  }>;
}

// ============================================================================
// Bundle Options
// ============================================================================

/**
 * Options for creating a bundle
 */
export interface BundleCreateOptions {
  /** Source directory containing the app files */
  sourceDir: string;
  /** Output path for the .softn bundle */
  outputPath: string;
  /** Whether to minify code */
  minify?: boolean;
  /** Whether to include source maps */
  sourceMaps?: boolean;
  /** Additional files to include */
  include?: string[];
  /** Files to exclude */
  exclude?: string[];
}

/**
 * Options for loading a bundle
 */
export interface BundleLoadOptions {
  /** Whether to validate the manifest */
  validate?: boolean;
  /** Whether to parse all files immediately */
  eager?: boolean;
  /** Custom XDB instance to use for data */
  xdb?: unknown;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate a manifest object
 */
export function validateManifest(manifest: unknown): manifest is SoftNManifest {
  if (!manifest || typeof manifest !== 'object') return false;

  const m = manifest as Record<string, unknown>;

  // Required fields
  if (typeof m.name !== 'string' || !m.name) return false;
  if (typeof m.version !== 'string' || !m.version) return false;
  if (typeof m.main !== 'string' || !m.main) return false;

  // Files must be an object if present
  if (m.files !== undefined && typeof m.files !== 'object') return false;

  return true;
}

/**
 * Create a default manifest
 */
export function createDefaultManifest(name: string): SoftNManifest {
  return {
    name,
    version: '1.0.0',
    main: 'main.ui',
    files: {
      ui: ['main.ui'],
      logic: [],
      xdb: [],
      assets: [],
    },
  };
}
