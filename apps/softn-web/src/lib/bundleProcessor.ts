/**
 * Bundle Processing — extracted from softn-loader/src/App.tsx
 *
 * Pure functions for reading .softn ZIP bundles, loading XDB data,
 * and resolving imports/logic into a single renderable source string.
 * No Tauri dependencies — uses only browser APIs.
 */

import { getXDB, readBundleEntries, classifyAsset, ASSET_CLASSIFICATIONS } from '@softn/core';
import type { PermissionConfig } from '@softn/core';

// ── Types ────────────────────────────────────────────────────────────

export interface BundleManifest {
  name: string;
  version: string;
  description?: string;
  main: string;
  icon?: string;
  files: {
    ui?: string[];
    logic?: string[];
    xdb?: string[];
    assets?: string[];
  };
  config?: {
    window?: {
      title?: string;
      width?: number;
      height?: number;
    };
    theme?: {
      primary?: string;
      mode?: 'light' | 'dark' | 'system';
    };
    server?: {
      url?: string;
      token?: string;
      collections?: string[];
    };
  };
  permissions?: import('@softn/core').AppPermissions;
}

interface XDBFile {
  collection: string;
  records: Array<{
    id: string;
    collection: string;
    data: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
    created_at?: string;
    updated_at?: string;
    deleted?: boolean;
  }>;
}

export interface ZipResult {
  textFiles: Map<string, string>;
  binaryFiles: Map<string, Uint8Array>;
}


// ── Helpers ──────────────────────────────────────────────────────────

function isBinaryFile(fileName: string): boolean {
  // The extension list lived here, in softn-loader, in core and in the demo
  // build script, and the four disagreed. @softn/core's registry is the only
  // copy now.
  return classifyAsset(fileName).binary;
}

/** Resolve a relative path against a base file path */
function resolvePath(basePath: string, relativePath: string): string {
  const baseParts = basePath.split('/');
  baseParts.pop(); // Remove filename to get directory

  const relativeParts = relativePath.split('/');
  for (const part of relativeParts) {
    if (part === '..') {
      baseParts.pop();
    } else if (part !== '.') {
      baseParts.push(part);
    }
  }

  const resolved = baseParts.filter(Boolean).join('/');
  // Reject paths that escape the bundle root (e.g., too many `..` segments)
  if (resolved.includes('..') || resolved.startsWith('/')) {
    throw new Error(`Unsafe import path: ${relativePath}`);
  }
  return resolved;
}

/** Escape special regex characters in a string */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Core Functions ───────────────────────────────────────────────────

/** Read ZIP entries from Uint8Array using fflate */
export function readZip(data: Uint8Array): ZipResult {
  const textFiles = new Map<string, string>();
  const binaryFiles = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();

  // Validation lives in @softn/core so all three readers share it. This file
  // and softn-loader each carried their own copy — identical today, but two
  // copies of a security check are two chances to fix only one — and the
  // builder had none at all.
  for (const [normalizedPath, content] of readBundleEntries(data)) {
    if (isBinaryFile(normalizedPath)) {
      binaryFiles.set(normalizedPath, content);
    } else {
      textFiles.set(normalizedPath, decoder.decode(content));
    }
  }

  console.log('[SoftN Web] Loaded files:', Array.from(textFiles.keys()));

  return { textFiles, binaryFiles };
}

/** Load XDB data from bundle files into XDB (browser sync mode) */
export async function loadXDBData(
  textFiles: Map<string, string>,
  manifest: BundleManifest,
  appId?: string
): Promise<void> {
  const xdb = getXDB(appId);
  const xdbFiles = manifest.files.xdb || [];

  const normalizeRecord = (
    collection: string,
    record: XDBFile['records'][number]
  ) => {
    const createdAt = record.created_at || record.createdAt || new Date().toISOString();
    const updatedAt = record.updated_at || record.updatedAt || createdAt;
    return {
      id: record.id,
      collection: record.collection || collection,
      data: record.data || {},
      created_at: createdAt,
      updated_at: updatedAt,
      deleted: record.deleted ?? false,
    };
  };

  for (const xdbFileName of xdbFiles) {
    const content = textFiles.get(xdbFileName);
    if (!content) continue;

    try {
      const xdbData: XDBFile = JSON.parse(content);
      const { collection, records } = xdbData;

      // Check if collection already has data (avoid duplicates on reload)
      const existing = xdb.query(collection);

      if (existing.length > 0) {
        console.log(
          `[SoftN Web] Collection ${collection} already has ${existing.length} records, skipping seed`
        );
        continue;
      }

      // Insert each record (preserve IDs/timestamps)
      for (const record of records) {
        const normalized = normalizeRecord(collection, record);
        xdb.writeRecord(collection, normalized);
      }

      console.log(`[SoftN Web] Loaded ${records.length} records into ${collection}`);
    } catch (err) {
      console.error(`[SoftN Web] Failed to load XDB file ${xdbFileName}:`, err);
    }
  }
}

/**
 * Process a bundle's main UI file: resolve `<logic src="..."/>` inlining
 * and `<import X from="..."/>` resolution into a single source string.
 * Logic file imports are NOT resolved here — they're handled natively by
 * the script runtime via the importResolver callback.
 */
export function processBundle(
  textFiles: Map<string, string>,
  manifest: BundleManifest
): { source: string; logicBasePath?: string; preIncludedLogicPaths: string[] } {
  const mainUI = textFiles.get(manifest.main);
  if (!mainUI) {
    throw new Error(`Main file not found: ${manifest.main}`);
  }

  let fullSource = mainUI;
  let logicBasePath: string | undefined;
  // Logic files concatenated below. Reported to the runtime so an `import`
  // naming one of them is skipped rather than inlining the file a second time.
  const preIncludedLogic = new Set<string>();
  /** The manifest's logic files go into the document once, at the first tag. */
  let manifestLogicEmitted = false;

  const inlineLogic = (source: string, basePath: string): string => {
    return source.replace(/<logic\s+src=["']([^"']+)["']\s*\/>/g, (match, rel) => {
      const logicPath = resolvePath(basePath, rel);
      console.log('[SoftN Web] Resolving logic:', rel, '->', logicPath);

      const logicFile = textFiles.get(logicPath);
      if (!logicFile) {
        // The tag is left in place and the app loads with no script at all, so
        // every button in it is inert. That is worth more than a warning: the
        // app looks finished and answers nothing.
        console.error(
          `[SoftN Web] ${logicPath} is referenced by the UI but is not in the bundle. ` +
            `The app will load with no logic, so its controls will do nothing.`
        );
        return match;
      }

      // Only the first <logic src> emits the manifest's logic bundle.
      //
      // Every tag used to concatenate all manifest-listed .logic files again, so
      // a second .ui file with its own <logic src> — an ordinary thing in a
      // multi-page app — redeclared every class and every top-level `let` in the
      // engine. The whole app then failed to load on a SyntaxError, with no error
      // card to say why.
      if (manifestLogicEmitted) {
        console.info(`[SoftN Web] ${logicPath} is already included; skipping the duplicate block.`);
        return '';
      }
      manifestLogicEmitted = true;
      // Capture the logic file's path for import resolution
      logicBasePath = logicPath;

      // Concatenate all manifest-listed .logic files into a single block.
      // Files other than the main entry are prepended so that their class/function
      // definitions are available when the main file's top-level code runs.
      const manifestLogicFiles = manifest.files.logic || [];
      const parts: string[] = [];
      for (const mlPath of manifestLogicFiles) {
        if (mlPath === logicPath) continue; // main entry added last
        const content = textFiles.get(mlPath);
        if (content) {
          console.log('[SoftN Web] Including manifest logic file:', mlPath);
          parts.push(content);
          preIncludedLogic.add(mlPath);
        }
      }
      parts.push(logicFile); // main entry last

      return `<logic>\n${parts.join('\n')}\n</logic>`;
    });
  };

  const inlineImports = (
    source: string,
    basePath: string,
    stack: Set<string>,
    cache: Map<string, string>
  ): string => {
    let nextSource = inlineLogic(source, basePath);
    const importRegex = /<import\s+(\w+)\s+from=["']([^"']+)["']\s*\/>/g;
    const imports: Array<{ name: string; path: string; content: string }> = [];

    let match;
    while ((match = importRegex.exec(nextSource)) !== null) {
      const componentName = match[1];
      const importPath = match[2];
      const resolvedPath = resolvePath(basePath, importPath);
      console.log('[SoftN Web] Resolving import:', componentName, '->', resolvedPath);

      const componentContent = textFiles.get(resolvedPath);
      if (componentContent) {
        if (cache.has(resolvedPath)) {
          imports.push({ name: componentName, path: resolvedPath, content: cache.get(resolvedPath)! });
          continue;
        }
        if (stack.has(resolvedPath)) {
          console.warn('[SoftN Web] Skipping circular import:', resolvedPath);
          continue;
        }
        stack.add(resolvedPath);
        const inlined = inlineImports(componentContent, resolvedPath, stack, cache);
        stack.delete(resolvedPath);
        cache.set(resolvedPath, inlined);
        imports.push({ name: componentName, path: resolvedPath, content: inlined });
      } else {
        console.warn('[SoftN Web] Imported file not found:', resolvedPath);
      }
    }

    nextSource = nextSource.replace(/<import\s+\w+\s+from=["'][^"']+["']\s*\/>\n?/g, '');

    for (const imp of imports) {
      const templateContent = imp.content
        .replace(/^\/\/[^\n]*\n/gm, '')
        .trim();

      const escapedName = escapeRegex(imp.name);
      // The tag name has to end where the name ends.
      //
      // `<${name}[^>]*>` let the character class eat the rest of a longer name,
      // so an import called Item matched `<ItemList>` — and the paired form then
      // ran to the first `</Item…>`, replacing that element AND everything
      // inside it with Item's markup. A component the author never referenced
      // deleted unrelated parts of their page. The name must be followed by
      // whitespace, `/` or `>`, which is what makes it that tag and not another
      // one starting with the same letters.
      const selfClosingRegex = new RegExp(`<${escapedName}(?:\\s[^>]*?)?\\s*/>`, 'g');
      // Function replacer: a component's markup is content, not a substitution
      // pattern. Passed as a string, `$&` re-inserts the tag it just replaced
      // and `$'` splices in the rest of the document.
      nextSource = nextSource.replace(selfClosingRegex, () => templateContent);

      const pairedRegex = new RegExp(
        `<${escapedName}(?:\\s[^>]*?)?>.*?</${escapedName}\\s*>`,
        'gs'
      );
      nextSource = nextSource.replace(pairedRegex, () => templateContent);
    }

    return nextSource;
  };

  fullSource = inlineImports(
    fullSource,
    manifest.main,
    new Set([manifest.main]),
    new Map()
  );

  console.log('[SoftN Web] Final source prepared with inlined components');

  return { source: fullSource, logicBasePath, preIncludedLogicPaths: [...preIncludedLogic] };
}

/**
 * Create an import resolver that looks up paths in the bundle's textFiles map.
 * For URL imports (http/https), fetches with caching.
 */
export function createImportResolver(
  textFiles: Map<string, string>,
  permissionConfig: PermissionConfig | null = null
): (path: string) => Promise<string | null> {
  const urlCache = new Map<string, string>();

  const remoteUrl = (value: string): URL | null => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }

    const permissions = permissionConfig?.permissions;
    const net = permissions && typeof permissions === 'object' ? permissions.net : undefined;

    // Remote imports are network access just as surely as fetch() in app logic.
    // Missing permission.json is therefore deny-by-default too: only an
    // explicit net.enabled grant reaches the network.
    if (!net || typeof net !== 'object' || !net.enabled) return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && net?.allow_http)) return null;
    if (
      Array.isArray(net?.allowed_hosts) &&
      net.allowed_hosts.length > 0 &&
      !net.allowed_hosts.includes(url.hostname)
    ) {
      return null;
    }
    return url;
  };

  const MAX_REMOTE_IMPORT_BYTES = 1024 * 1024;
  const REMOTE_IMPORT_TIMEOUT_MS = 10_000;

  const readBoundedText = async (response: Response): Promise<string | null> => {
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) > MAX_REMOTE_IMPORT_BYTES) return null;

    if (!response.body) {
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > MAX_REMOTE_IMPORT_BYTES) return null;
      return new TextDecoder().decode(bytes);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_REMOTE_IMPORT_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  };

  return async (path: string): Promise<string | null> => {
    // URL imports — fetch with caching
    if (path.startsWith('http://') || path.startsWith('https://')) {
      const requestedUrl = remoteUrl(path);
      if (!requestedUrl) return null;
      if (urlCache.has(requestedUrl.href)) return urlCache.get(requestedUrl.href)!;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REMOTE_IMPORT_TIMEOUT_MS);
      try {
        const response = await fetch(requestedUrl.href, { signal: controller.signal });
        if (!response.ok) return null;

        // Fetch follows redirects. Re-check the destination so an allowed host
        // cannot bounce the import to a host the user did not approve.
        if (response.url && !remoteUrl(response.url)) return null;

        const text = await readBoundedText(response);
        if (text === null) return null;
        urlCache.set(requestedUrl.href, text);
        return text;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }
    // Bundle path lookup
    return textFiles.get(path) ?? null;
  };
}

/**
 * Extract permission config from the bundle.
 * Checks for a dedicated permission.json first, then falls back to manifest.permissions.
 */
export function extractPermissions(textFiles: Map<string, string>, manifest: BundleManifest): PermissionConfig | null {
  // Check for permission.json in textFiles
  const permJson = textFiles.get('permission.json');
  if (permJson) {
    try {
      return JSON.parse(permJson) as PermissionConfig;
    } catch (e) {
      // A malformed permission.json must not be treated as an absent one.
      // `checkPermission` allows everything when the config is null (documented
      // backward compatibility for bundles predating the file), so falling
      // through here meant a bundle whose permission.json had a trailing comma
      // got strictly *more* privilege than the same bundle with valid JSON
      // declaring nothing at all. An empty config denies every capability,
      // which is the safe reading of "the author meant to declare something".
      console.error('[SoftN] Invalid permission.json — denying all capabilities:', e);
      return { permissions: {} } as PermissionConfig;
    }
  }
  // Fall back to manifest.permissions (backward compat)
  if (manifest?.permissions) {
    return {
      permissions: {
        net: manifest.permissions.network ? { enabled: true } : undefined,
        files: manifest.permissions.filesystem ? { enabled: true } : undefined,
      }
    };
  }
  return null;
}

/**
 * Every capability a permission config asks for.
 *
 * One list, read by both the consent check and the grant record, so the two
 * cannot disagree about what was approved.
 */
const CAPABILITIES = ['net', 'camera', 'mic', 'files', 'qr', 'ai', 'gpu', 'sync'] as const;

export function requestedCapabilities(config: PermissionConfig): string[] {
  const perms = (config.permissions ?? {}) as Record<string, { enabled?: boolean } | undefined>;
  return CAPABILITIES.filter((name) => perms[name]?.enabled);
}

/** Extract icon as a data URL from bundle binary files */
/**
 * Resolve `asset("images/x.png")` to something the browser can load.
 *
 * A bundle's images are inside the archive, so a template referencing one has to
 * be handed a URL rather than a path. Studio's preview has always provided this
 * function; the runtime provided no functions at all, so every `asset()` call in
 * a shipped app evaluated to undefined. The Office demo makes eight of them and
 * carries thirty-five images: every one of them was missing, and the console
 * filled with "Function asset not found" instead of anything saying why the page
 * had no pictures on it.
 *
 * Object URLs, made once per asset and cached, so a list rendering the same
 * image fifty times allocates it once. They live as long as the tab does.
 */
export interface AssetResolver {
  (assetPath: string): string;
  dispose(): void;
}

export function createAssetResolver(
  binaryFiles: Map<string, Uint8Array>,
  textFiles: Map<string, string>
): AssetResolver {
  const urls = new Map<string, string>();
  let disposed = false;

  const resolve = ((assetPath: string): string => {
    if (disposed) return '';
    if (typeof assetPath !== 'string' || !assetPath) return '';
    // Same refusal as the icon path: nothing that climbs out of the bundle.
    if (assetPath.includes('..') || assetPath.startsWith('/') || /^[a-zA-Z]:/.test(assetPath)) return '';

    const path = assetPath.replace(/^\.\//, '');
    const cached = urls.get(path);
    if (cached) return cached;

    // A MIME miss used to return '' here, so a .glb whose bytes were sitting
    // in the bundle resolved to an empty URL with nothing logged. An unknown
    // format is served as opaque bytes instead, and says so once.
    const { mime } = classifyAsset(path);
    warnUnknownAssetExtension(path);

    const binary = binaryFiles.get(path);
    // An SVG may have been read as text rather than as bytes, depending on how
    // the bundle was written; both are the same picture.
    const text = binary ? undefined : textFiles.get(path);
    if (!binary && text === undefined) return '';

    try {
      const blob = binary ? new Blob([binary as BlobPart], { type: mime }) : new Blob([text as string], { type: mime });
      const url = URL.createObjectURL(blob);
      urls.set(path, url);
      return url;
    } catch {
      return '';
    }
  }) as AssetResolver;

  resolve.dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
  };

  return resolve;
}

/** Extensions already warned about, so a folder of fifty unknowns logs once. */
const warnedAssetExtensions = new Set<string>();

function warnUnknownAssetExtension(path: string): void {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (ext in ASSET_CLASSIFICATIONS || warnedAssetExtensions.has(ext)) return;
  warnedAssetExtensions.add(ext);
  console.warn(
    `[SoftN Web] No MIME type registered for .${ext}; serving as application/octet-stream`
  );
}

export function extractIconDataUrl(
  binaryFiles: Map<string, Uint8Array>,
  manifest: BundleManifest
): string | undefined {
  if (!manifest.icon) return undefined;

  // Reject paths with traversal or absolute references
  if (manifest.icon.includes('..') || manifest.icon.startsWith('/') || /^[a-zA-Z]:/.test(manifest.icon)) {
    return undefined;
  }

  const iconData = binaryFiles.get(manifest.icon);
  if (!iconData) return undefined;

  const ext = manifest.icon.split('.').pop()?.toLowerCase() || 'png';
  // Allow safe image formats. SVG is safe here because icons are always
  // rendered via <img> tags, which never execute embedded scripts.
  const safeMimeTypes: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    ico: 'image/x-icon',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
  };
  const mime = safeMimeTypes[ext];
  if (!mime) return undefined;

  // Convert Uint8Array to base64
  let binary = '';
  for (let i = 0; i < iconData.length; i++) {
    binary += String.fromCharCode(iconData[i]);
  }
  return `data:${mime};base64,${btoa(binary)}`;
}
