import {
  composeBundleSource,
  parseXDBFile,
  rewriteBundleLogicImports,
  seedXDBBundleData,
  type ComposedBundleSource,
  type XDBBundleData,
  type XDBRecord,
  type XDBService,
} from '@softn/core';
import type { VFSFile } from '../types/studio';
import { normalizeManifestForBundle } from './exportBundle';
import { isPrivatePath, normalizeProjectPath } from './paths';

export interface PreviewXDBState {
  bundles: XDBBundleData[];
  collections: Set<string>;
  initialData: Record<string, XDBRecord[]>;
}

type PreviewXDB = Pick<
  XDBService,
  'clear' | 'getAllRaw' | 'resumeNotifications' | 'suppressNotifications' | 'writeRecord'
>;

/** What the preview renderer is given: the composed bundle, and how its logic imports resolve. */
export interface PreviewComposition extends ComposedBundleSource {
  importResolver: (path: string) => Promise<string | null>;
}

export type PreviewCompositionResult =
  | { ok: true; composition: PreviewComposition }
  | { ok: false; error: string };

/**
 * Compose the previewed `.ui` file the way the runtime composes the bundle's
 * `main`: with core's composer, over the project's text files, with the
 * manifest's logic group as the export will write it.
 *
 * Studio used to assemble the preview itself, and it was a second runtime
 * that disagreed with the first. It collected only `.logic` files, so a
 * Python app previewed as if it had no logic; it resolved a bare
 * `src="logic/app.logic"` from the bundle root where the runtime resolves it
 * from the importing file; it skipped a `<logic src>` whose file was missing,
 * so a project that stopped at Run looked fine here; and it passed imported
 * logic through unrewritten. The composer is the one the runtime runs, so
 * what it refuses is refused here, in its own words, before Run.
 *
 * The logic group comes from the normalised manifest rather than from every
 * logic file in the project: that is what Run and Export hand the runtime, so
 * a server file or a stray helper is not executed here when it would not be
 * there.
 */
export function composePreviewProject(files: Map<string, VFSFile>, mainPath: string): PreviewCompositionResult {
  const text = new Map<string, string>();
  for (const [rawPath, file] of files) {
    if (typeof file.content !== 'string') continue;
    const path = normalizeProjectPath(rawPath);
    if (!path || isPrivatePath(path)) continue;
    text.set(path, file.content);
  }

  try {
    const composed = composeBundleSource(text, mainPath, manifestLogicPaths(files));
    return {
      ok: true,
      composition: {
        ...composed,
        // An imported .logic file's own imports are relative to it, not to
        // the entry; the runtime rewrites them to bundle-root paths before
        // the fragment joins the one logic block, and so does the preview.
        importResolver: async (path: string): Promise<string | null> => {
          const canonical = normalizeProjectPath(path.replace(/^\.\//, ''));
          if (!canonical || isPrivatePath(canonical)) return null;
          const source = text.get(canonical);
          return source === undefined ? null : rewriteBundleLogicImports(source, canonical);
        },
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The manifest's logic group as the export writes it: the helpers the runtime loads, in its order. */
function manifestLogicPaths(files: Map<string, VFSFile>): string[] {
  const manifest = normalizeManifestForBundle(files);
  if (manifest === null) return [];
  const groups = (JSON.parse(manifest) as { files?: { logic?: unknown } }).files;
  return Array.isArray(groups?.logic)
    ? groups.logic.filter((path): path is string => typeof path === 'string')
    : [];
}

/**
 * Strip the author's `//` line comments from a `.ui` file's TEMPLATE, and only
 * its template.
 *
 * Comments in a .ui header would otherwise render as visible text in the
 * preview, which is the whole reason this exists. What it must not do is reach
 * inside `<logic>`, `<script>` or `<style>`: those are other languages, they
 * handle their own comments, and this once ran over them with two regexes that
 * know nothing about string literals.
 *
 * That was not theoretical. It used to run over the assembled document — the
 * `.ui` with its external `.logic` already inlined — and the AIChat demo
 * contains `softn.files.pickFile({ accept: "image/*" }, ...)`. The `/*` inside
 * that ordinary MIME wildcard opened a comment, and the non-greedy scan ran
 * forward to the first `*\/` it could find, deleting everything between,
 * including the `</logic>` that closed the inlined block.
 *
 * Protecting those blocks was not enough, because the template has the same
 * wildcard: `<FileChooser accept="image/*" />` followed anywhere later by a
 * `*\/` deleted the markup between them. And `/* … *\/` is not a template
 * comment at all — the runtime's lexer knows `//` and `<!-- -->`, nothing
 * else — so a block comment in a template is text in the runtime and is left
 * as text here. Only a line that begins with `//` is removed.
 */
export function stripTemplateComments(source: string): string {
  // Spans that belong to another language, left exactly as their author wrote them.
  const protectedSpans: Array<[number, number]> = [];
  const blockTag = /<(logic|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  for (const match of source.matchAll(blockTag)) {
    protectedSpans.push([match.index, match.index + match[0].length]);
  }

  const stripTemplate = (text: string): string => text.replace(/^\/\/.*$/gm, '');

  let out = '';
  let cursor = 0;
  for (const [start, end] of protectedSpans) {
    out += stripTemplate(source.slice(cursor, start));
    out += source.slice(start, end);
    cursor = end;
  }
  out += stripTemplate(source.slice(cursor));

  return out.replace(/\n\s*\n\s*\n/g, '\n\n').trim();
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

/**
 * The preview-data reset policy.
 *
 * The preview's XDB collections are disposable and seeded from the
 * project's .xdb files. When they are reseeded is decided by this key, and
 * only by this key: it changes when an .xdb file's content, path or
 * presence changes, and for nothing else. The seeding effect used to hang
 * off the whole file map, so editing a label in a .ui file threw away every
 * record the person had typed into the preview and put the sample data
 * back — a "reset" nobody had asked for. The rule now:
 *
 *   - Editing, adding, renaming or removing an .xdb file reseeds the
 *     preview data from source (the source is the truth for the schema and
 *     the sample records, and there is no meaningful way to merge it with
 *     records entered against the old shape).
 *   - Editing any other file — .ui, .logic, the manifest, an asset — keeps
 *     the preview's data as it is.
 *   - "Reset preview data" in the canvas toolbar reseeds on demand.
 *   - Closing the canvas or switching project clears the collections.
 *
 * The key is the concatenation of every .xdb file's path and content in
 * path order, so equality is exact, not a hash that could collide.
 */
export function previewDataKey(files: Map<string, VFSFile>): string {
  const parts: string[] = [];
  for (const [path, file] of files) {
    if (!/\.xdb$/i.test(path) || typeof file.content !== 'string') continue;
    parts.push(`${path}\0${file.content.length}\0${file.content}`);
  }
  parts.sort();
  return `${parts.length}\u0001${parts.join('\u0001')}`;
}

/** Whether a change from one key to the next calls for reseeding the preview data. */
export function shouldReseedPreviewData(previousKey: string, nextKey: string): boolean {
  return previousKey !== nextKey;
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
