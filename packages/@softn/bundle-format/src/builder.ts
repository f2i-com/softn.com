/**
 * `.softn` Application Packaging Builder (`createBundle` / `BundleBuilder`).
 *
 * Provides one reusable, validated packaging contract across SoftN hosts, CLI
 * tools, and guest application builders (`softn:bundle`). Handles manifest
 * generation, permission declarations, path validation, deterministic ZIP
 * compression, archive verification via `openBundleArchive`, and SHA-256 build
 * fingerprinting.
 */

import { zipSync } from 'fflate';
import { sha256Hex } from './crypto';
import { inspectBundle, type BundleInspection } from './inspect';
import {
  validateBundleEntries,
  validateBundlePath,
  type BundleValidationResult,
} from './validation';
import { MAX_ZIP_ENTRIES, MAX_ZIP_FILE_BYTES, openBundleArchive } from './zip';

const ENCODER = new TextEncoder();

export interface BundleBuilderDatabaseConfig {
  name: string;
  engine?: 'sqlite';
  file?: string;
  seedSql?: string;
  seedJson?: string | Record<string, unknown>;
  persist?: boolean;
  schemaVersion?: number;
  migrations?: Array<{
    version: number;
    file?: string;
    sql?: string;
    description?: string;
  }>;
}

export interface BundleBuilderBackendConfig {
  runtime: 'rust' | 'php' | 'javascript' | 'typescript' | 'python';
  entry: string;
  root?: string;
  mode?: 'api' | 'ssr';
  routes?: string[];
  interceptOrigins?: string[];
  env?: Record<string, string>;
  phpMode?: 'sapi' | 'worker';
}

export interface BundleBuilderOptions {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  engine?: 1 | 2;
  main?: string;
  frontendRoot?: string;
  icon?: string;
  theme?: 'light' | 'dark' | 'auto';
  author?: string;
  category?: string;
  subcategory?: string;
  tags?: string[];
  backend?: BundleBuilderBackendConfig;
  databases?: BundleBuilderDatabaseConfig[];
  imports?: Record<string, string>;
  permissions?: Record<string, unknown>;
  /** Optional nested manifest block accepted as an ergonomic alias for top-level fields. */
  manifest?: Record<string, unknown>;
  /** Optional extra manifest fields merged into generated `manifest.json`. */
  extraManifest?: Record<string, unknown>;
}

export interface BundleBuildOptions {
  /** ZIP deflate compression level `0..9` (default `6`). */
  level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  /** When `true` (default), throws if validation produces any errors. */
  strict?: boolean;
  /** Include a SHA-256 fingerprint (default `true`). */
  fingerprint?: boolean;
  /** Maximum total uncompressed bundle size ceiling in bytes (default 64 MiB). */
  maxBytes?: number;
}

export interface BuiltBundle {
  bytes: Uint8Array;
  size: number;
  sha256: string;
  fileCount: number;
  manifest: Record<string, unknown>;
  inspection: BundleInspection;
  validation: BundleValidationResult;
}

const DEFAULT_MAX_BUILD_BYTES = 64 * 1024 * 1024;

function normalizePathInput(path: string): string {
  const err = validateBundlePath(path);
  if (err) throw new Error(err);
  return path;
}

function inferMainPath(
  explicitMain: string | undefined,
  frontendRoot: string | undefined,
  files: ReadonlyMap<string, Uint8Array>,
  backend?: BundleBuilderBackendConfig
): string {
  if (explicitMain && explicitMain.trim()) return explicitMain.trim().replace(/^\/+/, '');
  const fe = frontendRoot ? frontendRoot.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : '';
  if (fe && files.has(`${fe}/index.html`)) return `${fe}/index.html`;
  if (files.has('public/index.html')) return 'public/index.html';
  if (files.has('index.html')) return 'index.html';
  if (files.has('app.html')) return 'app.html';
  if (backend?.entry) return backend.entry.replace(/^\/+/, '');
  const htmlFiles = [...files.keys()].filter((p) => /\.html?$/i.test(p)).sort();
  if (htmlFiles.length > 0) return htmlFiles[0];
  return 'index.html';
}

export class BundleBuilder {
  private readonly options: BundleBuilderOptions;
  private readonly files = new Map<string, Uint8Array>();
  private permissionsConfig: Record<string, unknown> | undefined;
  private totalBytes = 0;

  constructor(options: BundleBuilderOptions) {
    if (!options || typeof options !== 'object') {
      throw new Error('BundleBuilder requires an options object.');
    }
    const merged: BundleBuilderOptions =
      options.manifest && typeof options.manifest === 'object' && !Array.isArray(options.manifest)
        ? { ...(options.manifest as unknown as BundleBuilderOptions), ...options }
        : options;
    const name = typeof merged.name === 'string' ? merged.name.trim() : '';
    if (!name) {
      throw new Error('Bundle options must include a non-empty "name".');
    }
    this.options = {
      ...merged,
      name,
      version: typeof merged.version === 'string' && merged.version.trim() ? merged.version.trim() : '1.0.0',
      engine: merged.engine ?? 2,
    };
    if (merged.permissions) {
      this.permissionsConfig = structuredClone(merged.permissions);
    }
  }

  /** Add or overwrite a UTF-8 text file in the bundle. */
  addText(path: string, content: string): this {
    const clean = normalizePathInput(path);
    const bytes = ENCODER.encode(String(content));
    return this.putBytes(clean, bytes);
  }

  /** Add or overwrite a binary file in the bundle. */
  addBinary(path: string, data: Uint8Array | ArrayBuffer): this {
    const clean = normalizePathInput(path);
    const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data).slice();
    return this.putBytes(clean, bytes);
  }

  /** Add or overwrite a JSON file in the bundle. */
  addJson(path: string, value: unknown, pretty = true): this {
    return this.addText(path, pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value));
  }

  private putBytes(cleanPath: string, bytes: Uint8Array): this {
    if (bytes.byteLength > MAX_ZIP_FILE_BYTES) {
      throw new Error(`File "${cleanPath}" exceeds maximum single-file size (${MAX_ZIP_FILE_BYTES} bytes).`);
    }
    const existing = this.files.get(cleanPath);
    if (!existing && this.files.size >= MAX_ZIP_ENTRIES) {
      throw new Error(`Bundle exceeds maximum file count (${MAX_ZIP_ENTRIES}).`);
    }
    if (existing) this.totalBytes -= existing.byteLength;
    this.files.set(cleanPath, bytes);
    this.totalBytes += bytes.byteLength;
    return this;
  }

  /** Remove a previously added file from the bundle. */
  remove(path: string): boolean {
    const existing = this.files.get(path);
    if (!existing) return false;
    this.totalBytes -= existing.byteLength;
    return this.files.delete(path);
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  listFiles(): string[] {
    return [...this.files.keys()].sort();
  }

  /** Configure `permission.json` (`{ permissions: { ... } }` or capability map). */
  setPermissions(permissions: Record<string, unknown>): this {
    this.permissionsConfig = structuredClone(permissions);
    return this;
  }

  /** Construct the effective `manifest.json` object for this bundle. */
  buildManifestObject(): Record<string, unknown> {
    if (this.files.has('manifest.json')) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(this.files.get('manifest.json')!)) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Fall through to validation error
      }
    }
    const frontendRoot =
      this.options.frontendRoot !== undefined
        ? this.options.frontendRoot
        : this.files.has('public/index.html') && !this.files.has('index.html')
          ? 'public'
          : undefined;
    const main = inferMainPath(this.options.main, frontendRoot, this.files, this.options.backend);
    const manifest: Record<string, unknown> = {
      ...(this.options.extraManifest ?? {}),
      ...(this.options.id ? { id: this.options.id } : {}),
      name: this.options.name,
      version: this.options.version ?? '1.0.0',
      ...(this.options.description !== undefined ? { description: this.options.description } : {}),
      engine: this.options.engine ?? 2,
      main,
      ...(frontendRoot ? { frontendRoot } : {}),
      ...(this.options.icon ? { icon: this.options.icon } : {}),
      ...(this.options.theme ? { theme: this.options.theme } : {}),
      ...(this.options.author ? { author: this.options.author } : {}),
      ...(this.options.category ? { category: this.options.category } : {}),
      ...(this.options.subcategory ? { subcategory: this.options.subcategory } : {}),
      ...(this.options.tags && this.options.tags.length > 0 ? { tags: this.options.tags } : {}),
      ...(this.options.imports ? { imports: this.options.imports } : {}),
      ...(this.options.backend ? { backend: this.options.backend } : {}),
      ...(this.options.databases && this.options.databases.length > 0 ? { databases: this.options.databases } : {}),
    };
    return manifest;
  }

  /** Assemble the full entry map (including generated `manifest.json` and `permission.json`). */
  toEntries(): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    if (!this.files.has('manifest.json')) {
      out.set('manifest.json', ENCODER.encode(JSON.stringify(this.buildManifestObject(), null, 2)));
    }
    if (this.permissionsConfig && !this.files.has('permission.json')) {
      const normalized =
        'permissions' in this.permissionsConfig &&
        this.permissionsConfig.permissions &&
        typeof this.permissionsConfig.permissions === 'object'
          ? this.permissionsConfig
          : { permissions: this.permissionsConfig };
      out.set('permission.json', ENCODER.encode(JSON.stringify(normalized, null, 2)));
    }
    for (const key of this.listFiles()) {
      out.set(key, this.files.get(key)!);
    }
    return out;
  }

  /** Validate all bundle files, manifest fields, permissions, and migrations before zipping. */
  validate(): BundleValidationResult {
    return validateBundleEntries(this.toEntries());
  }

  /** Build, verify, and fingerprint the `.softn` ZIP archive. */
  async build(buildOptions: BundleBuildOptions = {}): Promise<BuiltBundle> {
    const maxBytes = buildOptions.maxBytes ?? DEFAULT_MAX_BUILD_BYTES;
    const entries = this.toEntries();
    let totalUncompressed = 0;
    for (const bytes of entries.values()) totalUncompressed += bytes.byteLength;
    if (totalUncompressed > maxBytes) {
      throw new Error(`Bundle uncompressed contents (${totalUncompressed} bytes) exceed limit (${maxBytes} bytes).`);
    }

    const validation = validateBundleEntries(entries);
    if (buildOptions.strict !== false && !validation.valid) {
      throw new Error(`Invalid .softn bundle: ${validation.errors.join('; ')}`);
    }

    // Deterministic entry order for reproducible build fingerprints.
    const zipInput: Record<string, Uint8Array> = Object.create(null);
    for (const key of [...entries.keys()].sort()) {
      zipInput[key] = entries.get(key)!;
    }
    const level = buildOptions.level ?? 6;
    const zipped = zipSync(zipInput, { level });
    if (zipped.byteLength > maxBytes) {
      throw new Error(`Compiled .softn bundle (${zipped.byteLength} bytes) exceeds limit (${maxBytes} bytes).`);
    }

    // Re-open through SoftN's hardened ZIP reader to verify archive integrity end-to-end.
    const verifiedArchive = openBundleArchive(zipped);
    verifiedArchive.release();
    const inspection = inspectBundle(zipped);
    const sha256 = buildOptions.fingerprint === false ? '' : await sha256Hex(zipped);

    return {
      bytes: zipped,
      size: zipped.byteLength,
      sha256,
      fileCount: entries.size,
      manifest: this.buildManifestObject(),
      inspection,
      validation,
    };
  }
}

/** Create a new SoftN `.softn` bundle builder. */
export function createBundle(options: BundleBuilderOptions): BundleBuilder {
  return new BundleBuilder(options);
}
