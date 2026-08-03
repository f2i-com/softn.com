import {
  parseXDBFile,
  seedXDBBundleData,
  type XDBBundleData,
  type XDBRecord,
  type XDBService,
} from '@softn/core';
import type { VFSFile } from '../types/studio';
import { normalizeProjectPath, resolveProjectRelativePath } from './projectImport';

export interface PreviewXDBState {
  bundles: XDBBundleData[];
  collections: Set<string>;
  initialData: Record<string, XDBRecord[]>;
}

type PreviewXDB = Pick<
  XDBService,
  'clear' | 'getAllRaw' | 'resumeNotifications' | 'suppressNotifications' | 'writeRecord'
>;

export interface PreviewSourceResult {
  source: string;
  preIncludedLogicPaths: string[];
}

/** Parse Studio's VFS data exactly as the bundle runtime parses `.xdb` files. */
export function buildPreviewXDBState(files: Map<string, VFSFile>): PreviewXDBState {
  const bundles: XDBBundleData[] = [];
  const recordsByCollection = new Map<string, Map<string, XDBRecord>>();

  for (const [path, file] of files) {
    if (!/\.xdb$/i.test(path) || typeof file.content !== 'string') continue;
    const data = parseXDBFile(path, file.content);
    bundles.push(data);

    let records = recordsByCollection.get(data.collection);
    if (!records) {
      records = new Map();
      recordsByCollection.set(data.collection, records);
    }
    for (const record of data.records) {
      if (records.has(record.id)) continue;
      records.set(record.id, {
        ...record,
        collection: data.collection,
        deleted: false,
      });
    }
  }

  return {
    bundles,
    collections: new Set(bundles.map((bundle) => bundle.collection)),
    initialData: Object.fromEntries(
      Array.from(recordsByCollection, ([collection, records]) => [
        collection,
        Array.from(records.values()),
      ])
    ),
  };
}

/** Replace disposable preview collections and emit one refresh per collection. */
export function replacePreviewXDBCollections(
  xdb: PreviewXDB,
  state: PreviewXDBState,
  previousCollections: Iterable<string> = []
): void {
  xdb.suppressNotifications();
  try {
    for (const collection of new Set([...previousCollections, ...state.collections])) {
      xdb.clear(collection);
    }
    for (const bundle of state.bundles) seedXDBBundleData(xdb, bundle);
  } finally {
    xdb.resumeNotifications();
  }
}

/** Remove every collection owned by a disposable Studio preview. */
export function clearPreviewXDBCollections(xdb: PreviewXDB, collections: Iterable<string>): void {
  xdb.suppressNotifications();
  try {
    for (const collection of new Set(collections)) xdb.clear(collection);
  } finally {
    xdb.resumeNotifications();
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteLogicImports(code: string, ownerPath: string): string {
  return code.replace(
    /^(\s*import\s+)(["'])([^"']+)\2(\s*;?\s*)$/gm,
    (_match, prefix: string, quote: string, importPath: string, suffix: string) => {
      const resolved = resolveProjectRelativePath(ownerPath, importPath);
      return resolved
        ? `${prefix}${quote}${resolved}${quote}${suffix}`
        : `/* rejected unsafe logic import */`;
    }
  );
}

/**
 * Inline component templates for Studio while hoisting every component-owned
 * logic block into the single top-level block understood by the parser.
 */
export function assemblePreviewSource(
  rootPath: string,
  rootSource: string,
  uiFiles: Map<string, string>,
  logicFiles: Map<string, string>
): PreviewSourceResult {
  const canonicalUI = new Map<string, string>();
  const canonicalLogic = new Map<string, string>();
  for (const [path, content] of uiFiles) {
    const canonical = normalizeProjectPath(path);
    if (canonical) canonicalUI.set(canonical, content);
  }
  for (const [path, content] of logicFiles) {
    const canonical = normalizeProjectPath(path);
    if (canonical) canonicalLogic.set(canonical, content);
  }

  const logicChunks = new Map<string, string>();
  const preIncludedLogicPaths = new Set<string>();
  const templateCache = new Map<string, string>();

  const extractOwnedLogic = (
    source: string,
    ownerPath: string
  ): { template: string; chunks: Array<{ key: string; code: string; externalPath?: string }> } => {
    let inlineIndex = 0;
    const chunks: Array<{ key: string; code: string; externalPath?: string }> = [];
    const template = source.replace(
      /<logic\b([^>]*)\/>|<logic\b([^>]*)>([\s\S]*?)<\/logic\s*>/gi,
      (
        _match,
        selfClosingAttributes: string | undefined,
        blockAttributes: string | undefined,
        body: string | undefined
      ) => {
        const attributes = selfClosingAttributes ?? blockAttributes ?? '';
        const srcMatch = attributes.match(/\bsrc\s*=\s*(["'])([^"']+)\1/i);
        if (srcMatch) {
          const resolved = resolveProjectRelativePath(ownerPath, srcMatch[2]);
          const content = resolved ? canonicalLogic.get(resolved) : undefined;
          if (resolved && content !== undefined) {
            chunks.push({
              key: resolved,
              code: rewriteLogicImports(content, resolved),
              externalPath: resolved,
            });
          }
        }
        if (body?.trim()) {
          const key = `${ownerPath}#inline-${inlineIndex++}`;
          chunks.push({ key, code: rewriteLogicImports(body, ownerPath) });
        }
        return '';
      }
    );
    return { template, chunks };
  };

  const resolveTemplate = (path: string, source: string, ancestors: Set<string>): string => {
    const cached = templateCache.get(path);
    if (cached !== undefined) return cached;
    if (ancestors.has(path)) return '';

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(path);
    const imports: Array<{ names: string[]; sourcePath: string }> = [];
    const ownedLogic = extractOwnedLogic(source, path);
    let template = ownedLogic.template.replace(
      /<import\s+(?:\{\s*([^}]+)\s*\}|([A-Za-z_$][\w$]*))\s+from\s*=\s*(["'])([^"']+)\3\s*\/>/g,
      (
        _match,
        named: string | undefined,
        defaultName: string | undefined,
        _quote: string,
        sourcePath: string
      ) => {
        const names = (named ?? defaultName ?? '')
          .split(',')
          .map(
            (name) =>
              name
                .trim()
                .split(/\s+as\s+/i)
                .at(-1) ?? ''
          )
          .filter(Boolean);
        imports.push({ names, sourcePath });
        return '';
      }
    );

    for (const imported of imports) {
      const resolved = resolveProjectRelativePath(path, imported.sourcePath);
      if (!resolved) continue;
      const candidates = /\.ui$/i.test(resolved) ? [resolved] : [resolved, `${resolved}.ui`];
      const componentPath = candidates.find((candidate) => canonicalUI.has(candidate));
      if (!componentPath) continue;

      const componentTemplate = resolveTemplate(
        componentPath,
        canonicalUI.get(componentPath)!,
        nextAncestors
      )
        .replace(/<data>[\s\S]*?<\/data>/gi, '')
        .trim();

      for (const name of imported.names) {
        const escapedName = escapeRegExp(name);
        template = template.replace(
          new RegExp(`<${escapedName}(?:\\s+[^>]*)?\\/\\s*>`, 'g'),
          () => componentTemplate
        );
        template = template.replace(
          new RegExp(`<${escapedName}(?:\\s+[^>]*)?>[\\s\\S]*?<\\/${escapedName}\\s*>`, 'g'),
          () => componentTemplate
        );
      }
    }

    // Component/helper declarations must exist before the importing file's
    // top-level statements execute. Recurse first, then append this file's
    // owned logic, with the root/main file consequently ordered last.
    for (const chunk of ownedLogic.chunks) {
      if (logicChunks.has(chunk.key)) continue;
      logicChunks.set(chunk.key, chunk.code);
      if (chunk.externalPath) preIncludedLogicPaths.add(chunk.externalPath);
    }

    templateCache.set(path, template);
    return template;
  };

  const canonicalRoot = normalizeProjectPath(rootPath);
  if (!canonicalRoot) return { source: rootSource, preIncludedLogicPaths: [] };
  const template = resolveTemplate(canonicalRoot, rootSource, new Set());

  const combinedLogic = Array.from(logicChunks.values()).join('\n');
  return {
    source: combinedLogic ? `<logic>\n${combinedLogic}\n</logic>\n${template}` : template,
    preIncludedLogicPaths: Array.from(preIncludedLogicPaths),
  };
}
