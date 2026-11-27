/**
 * SoftN Application Packaging Service & Trusted Artifact Registry.
 *
 * - `BundleBuilderService`: manages guest-initiated `.softn` archive building
 *   inside the container Worker (ordinary guest computation — requires no
 *   privileged host permission) with bounded chunked binary transfers so large
 *   SQLite databases and assets never hit ZIPP's 16 MiB message limit.
 * - `ContainerArtifactRegistry`: host-owned registry of validated `.softn`
 *   artifacts with opaque `softn-artifact:<id>` handles for dynamic nested app
 *   previews and FormLogic binary handoff.
 */

import {
  createBundle,
  inspectBundle,
  openBundleArchive,
  sha256Hex,
  validateBundleBytes,
  type BundleBuilder,
  type BundleBuilderOptions,
  type BundleInspection,
  type BundleValidationResult,
  type BuiltBundle,
} from '@softn/bundle-format';
import { randomUUID } from '@softn/bundle-format/crypto';

export const ARTIFACT_SCHEME = 'softn-artifact:';
export const ARTIFACT_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

const DEFAULT_MAX_BUILD_SESSIONS = 8;
const DEFAULT_MAX_BUILT_ARTIFACTS = 16;
const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_ARTIFACT_BYTES = 128 * 1024 * 1024;

export interface RegisteredArtifact {
  id: string;
  handle: string;
  bytes: Uint8Array;
  size: number;
  sha256: string;
  manifest: Record<string, unknown>;
  inspection: BundleInspection;
  validation: BundleValidationResult;
  createdAt: number;
}

export interface BundleArtifactSummary {
  frontend: string;
  backend: string | null;
  database: string | null;
  fileCount: number;
  size: number;
  manifest: Record<string, unknown>;
}

/**
 * Inspect a `.softn` archive and produce a human-readable stack summary for host
 * deployment confirmation dialogs (e.g. FormLogic).
 */
export function summarizeBundleArtifact(bytes: Uint8Array, inspection?: BundleInspection): BundleArtifactSummary {
  const archive = openBundleArchive(bytes);
  try {
    const names = archive.names();
    const manifestBytes = archive.read('manifest.json');
    let manifest: Record<string, unknown> = {};
    if (manifestBytes) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          manifest = parsed as Record<string, unknown>;
        }
      } catch {
        // leave empty
      }
    }
    const insp = inspection ?? inspectBundle(bytes);
    const hasTsx = names.some((n) => /\.(?:tsx|ts)$/i.test(n));
    const hasReact =
      hasTsx ||
      names.some((n) => /\.(?:jsx)$/i.test(n)) ||
      (manifest.imports && typeof manifest.imports === 'object' && 'react' in (manifest.imports as Record<string, unknown>));
    const frontend = hasReact && hasTsx
      ? 'React / TypeScript'
      : hasReact
        ? 'React / JavaScript'
        : hasTsx
          ? 'TypeScript'
          : 'HTML / JavaScript';
    const backendObj =
      manifest.backend && typeof manifest.backend === 'object' && !Array.isArray(manifest.backend)
        ? (manifest.backend as Record<string, unknown>)
        : null;
    const backendRuntime = typeof backendObj?.runtime === 'string'
      ? backendObj.runtime.toLowerCase()
      : insp.backendRuntime ?? null;
    const hasSlim = names.some((n) => /composer\.json$|slim/i.test(n));
    const backend = backendRuntime === 'php'
      ? (hasSlim ? 'PHP Slim' : 'PHP')
      : backendRuntime === 'rust'
        ? 'Rust'
        : backendRuntime === 'python'
          ? 'Python'
          : backendRuntime === 'typescript'
            ? 'TypeScript'
            : backendRuntime === 'javascript'
              ? 'JavaScript'
              : null;
    const hasDb =
      (Array.isArray(manifest.databases) && manifest.databases.length > 0) ||
      names.some((n) => /\.(?:db|sqlite|sqlite3|sql)$/i.test(n));
    return {
      frontend,
      backend,
      database: hasDb ? 'SQLite' : null,
      fileCount: names.length,
      size: bytes.byteLength,
      manifest,
    };
  } finally {
    archive.release();
  }
}

/**
 * Trusted host-side artifact registry for dynamic nested app previews and host deployment offers.
 */
export class ContainerArtifactRegistry {
  private readonly artifacts = new Map<string, RegisteredArtifact>();
  private totalBytes = 0;
  private readonly maxArtifactBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxCount: number;

  constructor(options?: { maxArtifactBytes?: number; maxTotalBytes?: number; maxCount?: number }) {
    this.maxArtifactBytes = Math.min(
      Math.max(1024 * 1024, options?.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES),
      128 * 1024 * 1024
    );
    this.maxTotalBytes = Math.min(
      Math.max(this.maxArtifactBytes, options?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_ARTIFACT_BYTES),
      256 * 1024 * 1024
    );
    this.maxCount = Math.min(Math.max(1, options?.maxCount ?? DEFAULT_MAX_BUILT_ARTIFACTS), 32);
  }

  async register(bytes: Uint8Array): Promise<RegisteredArtifact> {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new Error('Artifact must be a non-empty .softn archive');
    }
    if (bytes.byteLength > this.maxArtifactBytes) {
      throw new Error(`Artifact (${bytes.byteLength} bytes) exceeds maximum allowed size (${this.maxArtifactBytes} bytes)`);
    }
    if (this.artifacts.size >= this.maxCount) {
      throw new Error(`Container artifact registry limit reached (max ${this.maxCount} active artifacts)`);
    }
    if (this.totalBytes + bytes.byteLength > this.maxTotalBytes) {
      throw new Error(`Container artifact registry memory limit reached (max ${this.maxTotalBytes} bytes)`);
    }

    const copy = bytes.slice();
    // Validate ZIP structure & manifest through SoftN's hardened bundle contract before minting a handle
    const archive = openBundleArchive(copy);
    archive.release();
    const validation = validateBundleBytes(copy);
    if (!validation.valid) {
      throw new Error(`Invalid .softn artifact: ${validation.errors.join('; ')}`);
    }
    const sha256 = await sha256Hex(copy);
    const summary = summarizeBundleArtifact(copy, validation.inspection);
    const id = randomUUID().replace(/-/g, '');
    const record: RegisteredArtifact = {
      id,
      handle: `${ARTIFACT_SCHEME}${id}`,
      bytes: copy,
      size: copy.byteLength,
      sha256,
      manifest: summary.manifest,
      inspection: validation.inspection,
      validation,
      createdAt: Date.now(),
    };
    this.artifacts.set(id, record);
    this.totalBytes += copy.byteLength;
    return record;
  }

  has(id: string): boolean {
    return ARTIFACT_ID_RE.test(id) && this.artifacts.has(id);
  }

  get(id: string): RegisteredArtifact | undefined {
    if (!ARTIFACT_ID_RE.test(id)) return undefined;
    return this.artifacts.get(id);
  }

  remove(id: string): boolean {
    const existing = this.artifacts.get(id);
    if (!existing) return false;
    this.artifacts.delete(id);
    this.totalBytes = Math.max(0, this.totalBytes - existing.size);
    return true;
  }

  dispose(): void {
    this.artifacts.clear();
    this.totalBytes = 0;
  }
}

interface PendingBinaryUpload {
  chunks: Uint8Array[];
  totalBytes: number;
}

/**
 * Worker-side bundle builder session manager backing `softn:bundle`.
 * Holds in-progress `BundleBuilder` instances and built bundle outputs so the
 * guest can add multi-megabyte SQLite databases and hand built artifacts to
 * preview/download/deploy without base64-serializing full archives inside ZIPP.
 */
export class BundleBuilderService {
  private readonly sessions = new Map<string, { builder: BundleBuilder; uploads: Map<string, PendingBinaryUpload> }>();
  private readonly built = new Map<string, BuiltBundle>();
  private builtTotalBytes = 0;
  private readonly maxBundleBytes: number;
  private seq = 1;

  constructor(maxBundleBytes = DEFAULT_MAX_ARTIFACT_BYTES) {
    this.maxBundleBytes = Math.min(Math.max(1024 * 1024, maxBundleBytes), 128 * 1024 * 1024);
  }

  createSession(options: BundleBuilderOptions): { sessionId: string } {
    if (this.sessions.size >= DEFAULT_MAX_BUILD_SESSIONS) {
      throw new Error(`Too many active bundle builder sessions (max ${DEFAULT_MAX_BUILD_SESSIONS})`);
    }
    const builder = createBundle(options);
    const sessionId = `b_${this.seq++}_${randomUUID().slice(0, 8)}`;
    this.sessions.set(sessionId, { builder, uploads: new Map() });
    return { sessionId };
  }

  private getSession(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown or disposed bundle builder session: ${sessionId}`);
    return s;
  }

  addText(sessionId: string, path: string, content: string): { ok: true } {
    this.getSession(sessionId).builder.addText(path, content);
    return { ok: true };
  }

  addJson(sessionId: string, path: string, value: unknown): { ok: true } {
    this.getSession(sessionId).builder.addJson(path, value);
    return { ok: true };
  }

  appendBinaryChunk(sessionId: string, path: string, chunk: Uint8Array, final: boolean): { ok: true; size: number } {
    const s = this.getSession(sessionId);
    let pending = s.uploads.get(path);
    if (!pending) {
      pending = { chunks: [], totalBytes: 0 };
      s.uploads.set(path, pending);
    }
    if (pending.totalBytes + chunk.byteLength > this.maxBundleBytes) {
      s.uploads.delete(path);
      throw new Error(`Binary file "${path}" exceeds maximum bundle size (${this.maxBundleBytes} bytes)`);
    }
    if (chunk.byteLength > 0) {
      pending.chunks.push(chunk.slice());
      pending.totalBytes += chunk.byteLength;
    }
    if (final) {
      const merged = new Uint8Array(pending.totalBytes);
      let off = 0;
      for (const c of pending.chunks) {
        merged.set(c, off);
        off += c.byteLength;
      }
      s.uploads.delete(path);
      s.builder.addBinary(path, merged);
      return { ok: true, size: merged.byteLength };
    }
    return { ok: true, size: pending.totalBytes };
  }

  remove(sessionId: string, path: string): { ok: true; removed: boolean } {
    const s = this.getSession(sessionId);
    s.uploads.delete(path);
    return { ok: true, removed: s.builder.remove(path) };
  }

  setPermissions(sessionId: string, permissions: Record<string, unknown>): { ok: true } {
    this.getSession(sessionId).builder.setPermissions(permissions);
    return { ok: true };
  }

  listFiles(sessionId: string): string[] {
    return this.getSession(sessionId).builder.listFiles();
  }

  validate(sessionId: string): BundleValidationResult {
    return this.getSession(sessionId).builder.validate();
  }

  async build(
    sessionId: string,
    opts?: { level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9; strict?: boolean }
  ): Promise<{
    artifactToken: string;
    size: number;
    sha256: string;
    fileCount: number;
    manifest: Record<string, unknown>;
    inspection: BundleInspection;
    validation: BundleValidationResult;
  }> {
    const s = this.getSession(sessionId);
    const result = await s.builder.build({
      level: opts?.level,
      strict: opts?.strict,
      maxBytes: this.maxBundleBytes,
    });
    if (this.built.size >= DEFAULT_MAX_BUILT_ARTIFACTS) {
      // Evict oldest built artifact to keep memory bounded
      const oldest = this.built.keys().next().value;
      if (oldest !== undefined) this.disposeBuilt(oldest);
    }
    if (this.builtTotalBytes + result.size > DEFAULT_MAX_TOTAL_ARTIFACT_BYTES) {
      throw new Error(`Built bundle cache limit exceeded (${DEFAULT_MAX_TOTAL_ARTIFACT_BYTES} bytes); dispose unused bundles first`);
    }
    const artifactToken = `art_${this.seq++}_${randomUUID().slice(0, 8)}`;
    this.built.set(artifactToken, result);
    this.builtTotalBytes += result.size;
    return {
      artifactToken,
      size: result.size,
      sha256: result.sha256,
      fileCount: result.fileCount,
      manifest: result.manifest,
      inspection: result.inspection,
      validation: result.validation,
    };
  }

  getBuilt(artifactToken: string): BuiltBundle | undefined {
    return this.built.get(artifactToken);
  }

  disposeBuilt(artifactToken: string): boolean {
    const existing = this.built.get(artifactToken);
    if (!existing) return false;
    this.built.delete(artifactToken);
    this.builtTotalBytes = Math.max(0, this.builtTotalBytes - existing.size);
    return true;
  }

  disposeSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  dispose(): void {
    this.sessions.clear();
    this.built.clear();
    this.builtTotalBytes = 0;
  }
}
