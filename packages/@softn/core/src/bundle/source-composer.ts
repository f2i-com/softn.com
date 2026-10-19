/**
 * Shared bundle source composition for the browser and desktop loaders.
 *
 * A SoftN document can acquire logic from its main UI, imported UI components,
 * and manifest-listed helper files. The parser intentionally exposes one logic
 * block, so loaders must combine those inputs before parsing. This module keeps
 * that operation identical across hosts and canonicalizes relative imports
 * while each fragment's real source path is still known.
 *
 * An imported page is an include, not a component. `<import Header
 * from="./header.ui" />` puts header.ui's markup wherever `<Header />` is
 * written, as text, in the importing page's scope: it reads that page's state
 * and calls its functions, and its `<logic>` joins the page's one block.
 * Nothing is passed to it — attributes and children written on the tag are
 * dropped, and said so. What a page carries only when it stands on its own
 * — `<data>` declarations, `<style>` rules, an `<App>` wrapper — is handed
 * to the document instead of being pasted inside it (see page-include.ts).
 */

import { PYTHON_PACKAGES, readPythonPackages } from './inspect';
import { isRemoteReference, scriptLanguage } from '../parser/html';
import { moduleSyntaxAsScript } from '../runtime/module-syntax';
import {
  declareCollections,
  declareStyles,
  placeInclude,
  readInclude,
  type IncludedCollection,
} from './page-include';

export interface ComposedBundleSource {
  source: string;
  logicBasePath?: string;
  preIncludedLogicPaths: string[];
  /**
   * The languages this bundle's logic is written in, derived from its file
   * names and nothing else. Always contains `javascript`: the markup and its
   * template expressions are evaluated host-side whatever the `.logic` is.
   */
  languages: string[];
  /**
   * The Python modules, when the logic is Python. Absent for every bundle that
   * has ever shipped, which keeps the JavaScript path exactly what it was.
   */
  python?: { files: Record<string, string>; modules: string[]; packages: string[] };
}

/** A logic file ending in this is Python; everything else is JavaScript. */
export const PYTHON_LOGIC_SUFFIX = '.py';

/**
 * The standard-library modules the runtime's own `softn.py` imports.
 *
 * ZIPP resolves an import against the project's files before the built-in
 * module, so an app file `json.py` would replace the encoder every capability
 * argument goes through — silently, and for every call. Listed here by hand
 * rather than imported from `runtime/python/`, so the bundle composer does
 * not pull the runtime in; `test/python-contract.test.ts` reads the imports
 * out of the generated `SOFTN_PY` and fails if the two lists differ.
 */
export const SOFTN_PY_STDLIB_IMPORTS: readonly string[] = ['json', 'math'];

/**
 * Why a module name is the runtime's and not the app's, or null when it is
 * the app's to take.
 *
 * `softn` is the module an app imports; every other generated name starts
 * `__softn`, so that an app's own `main.py` — which is what the Builder's
 * `logic/main.logic` becomes — is a name it can still have; and the standard
 * library modules `softn.py` itself imports are reserved because the project
 * would shadow them.
 */
export function reservedPythonModuleReason(name: string): string | null {
  if (name === 'softn') return 'it is the module an app imports';
  if (PYTHON_PACKAGES.includes(name)) return `it is the ${name} package the runtime provides`;
  if (name.startsWith('__softn')) return 'the runtime generates it';
  if (SOFTN_PY_STDLIB_IMPORTS.includes(name)) {
    return `the runtime's own softn.py imports the standard library's ${name}, and a project file of that name would replace it`;
  }
  return null;
}

const isReservedPythonModule = (name: string): boolean => reservedPythonModuleReason(name) !== null;

const PYTHON_MODULE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Whether a bundle path names a Python logic file. */
export function isPythonLogicPath(path: string): boolean {
  return path.toLowerCase().endsWith(PYTHON_LOGIC_SUFFIX);
}

/**
 * The Python module name a bundle path is imported as: its file name without
 * the extension.
 *
 * Python imports by module name, not by path, so a `.py` file's name is also
 * its identity inside the project. A name Python could not import, or one the
 * runtime already uses, is refused here rather than becoming an import error
 * about a file the author cannot see.
 */
export function pythonModuleName(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1, -PYTHON_LOGIC_SUFFIX.length);
  if (!PYTHON_MODULE_NAME.test(base)) {
    throw new Error(
      `${path} cannot be a Python module: name it with letters, digits and underscores, starting with a letter`
    );
  }
  if (isReservedPythonModule(base)) {
    throw new Error(
      `${path} uses the reserved module name ${base}.py (${reservedPythonModuleReason(base)}); choose another name`
    );
  }
  return base;
}

/**
 * The Python packages a bundle's manifest declares. A declaration the
 * inspector would refuse is refused here too, so an app with a misspelt
 * package stops before it runs rather than at its first import. A manifest
 * that is missing or is not JSON declares nothing: the composer is not where
 * a malformed manifest is reported, and a bundle without one still composes.
 */
function declaredPythonPackages(manifestText: string | undefined): string[] {
  if (manifestText === undefined) return [];
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return [];
  }
  const { packages, problems } = readPythonPackages(manifest);
  if (problems.length > 0) throw new Error(problems[0]);
  return packages;
}

/**
 * Whether Python source imports a package: `import torch`, `import torch.nn
 * as nn`, `from torch import nn`, or the package among other names on one
 * `import` line. Read from the source rather than from the engine, so an
 * undeclared package is named before anything compiles; a line that merely
 * mentions the name (`import torchvision`, a comment) does not count.
 */
function importsPackage(code: string, name: string): boolean {
  const escaped = escapeRegex(name);
  const statement = new RegExp(
    `^[ \\t]*(?:from[ \\t]+${escaped}(?:\\.|[ \\t])|import[ \\t][^\\n#]*\\b${escaped}(?![\\w]))`,
    'm'
  );
  return statement.test(code);
}

interface LogicFragment {
  code: string;
  /** Path imports in inline logic are relative to, or the external file path. */
  basePath: string;
  /** Present when this fragment came from a standalone .logic file. */
  externalPath?: string;
  /** Main-document logic runs after helpers/component logic. */
  main: boolean;
  /** True for a fragment that came from a `.py` file. */
  python?: boolean;
}

function normalizeRootPath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Unsafe bundle path: ${value}`);
  }

  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error(`Unsafe bundle path: ${value}`);
    parts.push(part);
  }
  if (parts.length === 0) throw new Error(`Unsafe bundle path: ${value}`);
  return parts.join('/');
}

/** Resolve a UI/logic reference without allowing it to leave the bundle root. */
export function resolveBundlePath(basePath: string, relativePath: string): string {
  const normalizedBase = normalizeRootPath(basePath);
  const normalizedRelative = relativePath.replace(/\\/g, '/');
  if (normalizedRelative.startsWith('/') || /^[A-Za-z]:\//.test(normalizedRelative)) {
    throw new Error(`Unsafe import path: ${relativePath}`);
  }

  const parts = normalizedBase.split('/');
  parts.pop();
  for (const part of normalizedRelative.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) throw new Error(`Unsafe import path: ${relativePath}`);
      parts.pop();
    } else {
      parts.push(part);
    }
  }

  if (parts.length === 0) throw new Error(`Unsafe import path: ${relativePath}`);
  return parts.join('/');
}

/**
 * Turn fragment-relative .logic imports into canonical bundle-root paths.
 *
 * The runtime treats a path without ./ or ../ as bundle-root relative. Once
 * rewritten, fragments from different folders can safely share one compiled
 * logic block without borrowing the entry file's directory. A file written
 * as a module (`export function`, `import { a } from "./b.js"`) is read as
 * the script it is first, so its imports are placed like any other.
 */
export function rewriteBundleLogicImports(source: string, basePath: string): string {
  source = moduleSyntaxAsScript(source);
  return source.replace(
    new RegExp(LOGIC_IMPORT_LINE.source, 'gm'),
    (line, prefix: string, quote: string, rawPath: string, suffix: string, carriage: string) => {
      const path = logicImportPath(basePath, rawPath);
      return path === null ? line : `${prefix}${quote}${path}${quote}${suffix}${carriage}`;
    }
  );
}

/** A whole-file `import "./x.js"` line of logic; group 3 is the path as written. */
const LOGIC_IMPORT_LINE = /^([ \t]*import[ \t]+)(["'])([^"'\r\n]+)\2([ \t]*;?[ \t]*)(\r?)$/m;

/**
 * The bundle path an `import` in the logic file at `basePath` names: from
 * that file for `./` and `../`, from the bundle's root otherwise. Null for an
 * address on another site, which the runtime fetches itself.
 */
function logicImportPath(basePath: string, rawPath: string): string | null {
  if (rawPath.startsWith('http://') || rawPath.startsWith('https://')) return null;
  return rawPath.startsWith('./') || rawPath.startsWith('../')
    ? resolveBundlePath(basePath, rawPath)
    : normalizeRootPath(rawPath);
}

/**
 * The bundle paths the logic file at `basePath` imports, read as the runtime
 * places them: written as a module or as a script (see moduleSyntaxAsScript).
 * A path that would climb out of the bundle is left out; the composer refuses
 * it where it is placed.
 */
export function logicImportPaths(source: string, basePath: string): string[] {
  const paths: string[] = [];
  for (const match of moduleSyntaxAsScript(source).matchAll(new RegExp(LOGIC_IMPORT_LINE.source, 'gm'))) {
    try {
      const path = logicImportPath(basePath, match[3]);
      if (path !== null) paths.push(path);
    } catch {
      // An unsafe path; the composer says so.
    }
  }
  return paths;
}

/**
 * The stylesheet a `<link>` names, when it is one of the app's: `rel`
 * includes `stylesheet` and `href` is not on another site. Null otherwise.
 */
function stylesheetHref(attributes: string): string | null {
  const rel =
    attributes.match(/\brel\s*=\s*(["'])([^"']*)\1/i)?.[2] ??
    attributes.match(/\brel\s*=\s*([^\s"'>/]+)/i)?.[1];
  if (!rel || !rel.toLowerCase().split(/\s+/).includes('stylesheet')) return null;
  const href = attributes.match(/\bhref\s*=\s*(["'])([^"']+)\1/i)?.[2];
  return href && !isRemoteReference(href) ? href : null;
}

/** A lower-case `<link>` tag: group 1 is its attributes. `<Link>` is a component. */
const LINK_TAG = /<link\b([^>]*?)\/?>/;

/** The app's stylesheets a page links with `<link rel="stylesheet" href>`, as written, in order. */
export function pageStylesheetHrefs(source: string): string[] {
  const hrefs: string[] = [];
  for (const match of source.matchAll(new RegExp(LINK_TAG.source, 'g'))) {
    const href = stylesheetHref(match[1]);
    if (href !== null) hrefs.push(href);
  }
  return hrefs;
}

/** Escape a name before embedding it in a regular expression. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The `from` of an import, as the text of a pattern: the word, an `=` or
 * none, and the quoted path, which is its one group.
 */
const IMPORT_FROM = String.raw`from\s*=?\s*["']([^"']+)["']`;

/**
 * How a page imports another: `<import Header from="./header.ui" />`. Group 1
 * is the name it is used by, group 2 the path as written.
 *
 * The `=` may be left out. The parser reads `from "./header.ui"` as the same
 * import, and the composer used to look for the first spelling only, so a
 * page written the second way parsed cleanly and then had none of its
 * imports placed. Every place that looks for an import builds on this one
 * pattern, so the two cannot come apart again.
 */
export const UI_IMPORT_PATTERN = new RegExp(String.raw`<import\s+(\w+)\s+${IMPORT_FROM}\s*\/>`);

/**
 * Any import a page writes, whatever it names: `<import Header from=…>`,
 * `<import { Row, Cell } from=…>`, or a name and a list together. Group 1 is
 * the name, group 2 what is between the braces, group 3 the path.
 *
 * The bundle reader lists a page's imports with this. It had a pattern of its
 * own, which read `from "./x.ui"` and not `from="./x.ui"` — the opposite of
 * the composer's — so the spelling every shipped app uses listed nothing.
 * Both are built on the same reading of `from` now.
 */
export const UI_IMPORT_DECLARATION_PATTERN = new RegExp(
  String.raw`<import\s+(?:(\w+)\s+)?(?:\{([^}]+)\}\s*)?${IMPORT_FROM}\s*\/>`
);

/**
 * A `<logic>` or `<script>` tag and its content, when it has any: group 1 the
 * tag's name, group 2 its attributes, group 3 its content. Build a global
 * pattern from `.source` to go through a page.
 */
export const LOGIC_TAG_PATTERN = /<(logic|script)\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/\1\s*>)/i;

/**
 * What a `<logic>` or `<script>` tag is to the composer: `code` when it holds
 * or names the page's code, with the file it names as `src` (null for code
 * written inline); or `ignored` when the page leaves it alone. `<script>` is
 * `<logic>` as an HTML page spells it; a script that is not code (JSON, a
 * template) or comes from another site is passed over (the parser says the
 * second is not loaded).
 *
 * One rule, for the composer that places the code and for an editor that
 * lists what a page links, so the two cannot disagree about a page.
 */
export function logicTagReference(
  tag: string,
  attributes: string
): { kind: 'code'; src: string | null; language: 'javascript' | 'python' } | { kind: 'ignored' } {
  const script = tag.toLowerCase() === 'script';
  const type = attributes.match(/\btype\s*=\s*(["'])([^"']*)\1/i)?.[2];
  const language = script ? scriptLanguage(type) : 'javascript';
  if (language === 'other') return { kind: 'ignored' };
  const src = attributes.match(/\bsrc\s*=\s*(["'])([^"']+)\1/i)?.[2] ?? null;
  if (src && script && isRemoteReference(src)) return { kind: 'ignored' };
  return { kind: 'code', src, language };
}

/** The files of code a page names, `<script src>` and `<logic src>`, as written, in order. */
export function pageLogicSources(source: string): string[] {
  const sources: string[] = [];
  for (const match of source.matchAll(new RegExp(LOGIC_TAG_PATTERN.source, 'gi'))) {
    const reference = logicTagReference(match[1], match[2]);
    if (reference.kind === 'code' && reference.src) sources.push(reference.src);
  }
  return sources;
}

/** What a use of an imported page carried that an include cannot take, as a sentence. */
function describeIgnored(attributes: readonly string[], children: boolean): string {
  const written = attributes.length > 0 ? `attributes (${attributes.join(', ')})` : '';
  if (written && children) return `${written} and children`;
  return written || 'children';
}

/**
 * Inline a bundle's imported pages and combine every discovered logic
 * fragment into the document's single final <logic> block.
 */
export function composeBundleSource(
  textFiles: ReadonlyMap<string, string>,
  mainFilePath: string,
  manifestLogicPaths: readonly string[] = []
): ComposedBundleSource {
  const mainPath = normalizeRootPath(mainFilePath);
  const mainUI = textFiles.get(mainPath);
  if (mainUI === undefined) throw new Error(`Main file not found: ${mainFilePath}`);
  // An empty document parses to nothing, and nothing never finishes loading:
  // the renderer only starts on a non-empty source, so a host waiting for the
  // app to load waited forever on a blank tab with nothing in the console.
  if (mainUI.trim() === '') {
    throw new Error(`${mainPath} is empty: the app's main file needs markup for the app to show`);
  }

  const mainFragments: LogicFragment[] = [];
  const supplementalFragments: LogicFragment[] = [];
  const externalFragments = new Map<string, LogicFragment>();
  // The collections imported pages declare, with the page each came from.
  // Like their logic, they belong to the document: see declareCollections.
  const includedCollections: Array<IncludedCollection & { from: string }> = [];
  // And the rules of their `<style>` blocks, for the document's one block.
  const includedStyles: string[] = [];
  let firstFragment: LogicFragment | undefined;
  let sawExternalLogic = false;

  const rememberFragment = (fragment: LogicFragment): void => {
    firstFragment ??= fragment;
    (fragment.main ? mainFragments : supplementalFragments).push(fragment);
  };

  const collectLogic = (source: string, uiPath: string, main: boolean): string => {
    // See logicTagReference: what is left alone stays in the page, for the
    // parser.
    const logicTag = new RegExp(LOGIC_TAG_PATTERN.source, 'gi');
    return source.replace(logicTag, (fullTag, tag: string, attributes: string, inlineCode?: string) => {
      const reference = logicTagReference(tag, attributes);
      if (reference.kind === 'ignored') return fullTag;
      const { src, language } = reference;
      const type = attributes.match(/\btype\s*=\s*(["'])([^"']*)\1/i)?.[2];
      if (src) {
        sawExternalLogic = true;
        const externalPath = resolveBundlePath(uiPath, src);
        const existing = externalFragments.get(externalPath);
        if (existing) return '';

        const externalSource = textFiles.get(externalPath);
        if (externalSource === undefined) {
          throw new Error(`${externalPath} is referenced by ${uiPath} but is not in the bundle`);
        }
        const python = isPythonLogicPath(externalPath);
        const fragment: LogicFragment = {
          // Python has no `import "./x.logic"` line to rewrite, and rewriting
          // one would edit the author's source: Python imports by module name.
          code: python ? externalSource : rewriteBundleLogicImports(externalSource, externalPath),
          basePath: externalPath,
          externalPath,
          main,
          python,
        };
        externalFragments.set(externalPath, fragment);
        rememberFragment(fragment);
        return '';
      }

      // A self-closing <logic /> without src is malformed but harmless; retain
      // it so the parser can surface the author's input rather than invent code.
      if (inlineCode === undefined) return fullTag;
      // Python is whitespace-significant and markup indentation is not
      // reliable — an editor, a formatter or a component inliner can reindent
      // a block and change what the code means. So Python lives in a file the
      // bundle carries verbatim, and saying otherwise inline is refused rather
      // than silently mis-indented.
      const lang = attributes.match(/\blang(?:uage)?\s*=\s*(["'])([^"']*)\1/i)?.[2];
      if (lang && lang.trim().toLowerCase() === 'python') {
        throw new Error(
          `${uiPath} has an inline <logic lang="python"> block: put Python in a .py file and reference it with <logic src="...">`
        );
      }
      if (language === 'python') {
        throw new Error(
          `${uiPath} has an inline <script type="${type}"> block: put Python in a .py file and reference it with <script src="...">`
        );
      }
      const fragment: LogicFragment = {
        code: rewriteBundleLogicImports(inlineCode, uiPath),
        basePath: uiPath,
        main,
      };
      rememberFragment(fragment);
      return '';
    });
  };

  /**
   * `<link rel="stylesheet" href="styles.css">`: a stylesheet of the app's,
   * named as an HTML page names one. Its rules take the tag's place as a
   * `<style>` block, which is what the page would have written inline, so
   * they join the page's stylesheet like any other. One from another site is
   * left in the page, which does not load it; so is one the bundle does not
   * carry, said here. Lower case only: `<Link>` is a component.
   */
  const inlineStylesheets = (source: string, pagePath: string): string =>
    source.replace(new RegExp(LINK_TAG.source, 'g'), (fullTag, attributes: string) => {
      const href = stylesheetHref(attributes);
      if (href === null) return fullTag;
      const stylesheetPath = resolveBundlePath(pagePath, href);
      const rules = textFiles.get(stylesheetPath);
      if (rules === undefined) {
        console.warn(`[SoftN] ${pagePath}: the stylesheet ${stylesheetPath} is not in the bundle.`);
        return fullTag;
      }
      return `<style>\n${rules}\n</style>`;
    });

  const inlineImports = (
    source: string,
    basePath: string,
    stack: Set<string>,
    cache: Map<string, string>,
    main: boolean
  ): string => {
    let nextSource = collectLogic(inlineStylesheets(source, basePath), basePath, main);

    if (!main) {
      // An imported page is placed inside another, so what only a whole page
      // carries comes off it here, once, however often the page is used. It
      // is read before the pages it imports in turn, so that what it declares
      // comes before what they do.
      const include = readInclude(nextSource);
      nextSource = include.markup;
      for (const collection of include.collections) {
        includedCollections.push({ ...collection, from: basePath });
      }
      for (let i = 0; i < include.unusable; i++) {
        console.warn(
          `[SoftN] ${basePath}: a <collection> in its <data> block has no usable name and is not declared.`
        );
      }
      includedStyles.push(...include.styles);
    }

    const importRegex = new RegExp(UI_IMPORT_PATTERN.source, 'g');
    const imports: Array<{ name: string; path: string; content: string }> = [];

    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(nextSource)) !== null) {
      const componentName = match[1];
      const resolvedPath = resolveBundlePath(basePath, match[2]);
      const componentContent = textFiles.get(resolvedPath);
      if (componentContent === undefined) {
        console.warn('[SoftN] Imported UI file not found:', resolvedPath);
        continue;
      }
      if (cache.has(resolvedPath)) {
        imports.push({
          name: componentName,
          path: resolvedPath,
          content: cache.get(resolvedPath)!,
        });
        continue;
      }
      if (stack.has(resolvedPath)) {
        console.warn('[SoftN] Skipping circular UI import:', resolvedPath);
        continue;
      }

      stack.add(resolvedPath);
      const inlined = inlineImports(componentContent, resolvedPath, stack, cache, false);
      stack.delete(resolvedPath);
      cache.set(resolvedPath, inlined);
      imports.push({ name: componentName, path: resolvedPath, content: inlined });
    }

    nextSource = nextSource.replace(new RegExp(`${UI_IMPORT_PATTERN.source}\\n?`, 'g'), '');

    if (main) {
      // Every imported page has been read by now, so this is where what they
      // declared is declared: on the page that is the document.
      const declared = declareCollections(nextSource, includedCollections);
      nextSource = declared.source;
      for (const { declaration, holder } of declared.refused) {
        console.warn(
          `[SoftN] ${declaration.from}: <collection name="${declaration.name}" as="${declaration.as}"> is not declared, because this app already reads "${holder}" as ${declaration.as}.`
        );
      }
      nextSource = declareStyles(nextSource, includedStyles);
    }

    for (const imported of imports) {
      const template = imported.content.replace(/^\/\/[^\n]*\n/gm, '').trim();
      nextSource = placeInclude(nextSource, imported.name, template, ({ attributes, children }) => {
        // Dropped, as they always were: the language has no properties or
        // events for an imported page. Said, because dropping them silently
        // reads as a page that was passed its data and ignored it.
        console.warn(
          `[SoftN] ${basePath}: <${imported.name}> is an imported page, so its ${describeIgnored(attributes, children)} are ignored. It is placed here as written and reads this page's state instead.`
        );
      });
    }
    return nextSource;
  };

  let source = inlineImports(mainUI, mainPath, new Set([mainPath]), new Map(), true);
  if (!firstFragment) {
    return { source, preIncludedLogicPaths: [], languages: ['javascript'] };
  }

  // Main-document logic is the entry and runs after helpers/components. If the
  // main document has none, preserve the established behavior: the first logic
  // reference encountered becomes the entry and runs last.
  const entryFragments = mainFragments.length > 0 ? mainFragments : [firstFragment];
  const entrySet = new Set(entryFragments);
  const ordered: LogicFragment[] = [];
  const used = new Set<LogicFragment>();
  const addOrdered = (fragment: LogicFragment): void => {
    if (entrySet.has(fragment) || used.has(fragment)) return;
    used.add(fragment);
    ordered.push(fragment);
  };

  // Manifest helpers historically run before component and entry logic. Reuse
  // an explicitly referenced fragment when possible so it still appears once.
  if (sawExternalLogic) {
    const seenManifestPaths = new Set<string>();
    for (const rawPath of manifestLogicPaths) {
      const manifestPath = normalizeRootPath(rawPath);
      if (seenManifestPaths.has(manifestPath)) continue;
      seenManifestPaths.add(manifestPath);

      const referenced = externalFragments.get(manifestPath);
      if (referenced) {
        addOrdered(referenced);
        continue;
      }
      const manifestSource = textFiles.get(manifestPath);
      if (manifestSource === undefined) continue;
      const python = isPythonLogicPath(manifestPath);
      const fragment: LogicFragment = {
        code: python ? manifestSource : rewriteBundleLogicImports(manifestSource, manifestPath),
        basePath: manifestPath,
        externalPath: manifestPath,
        main: false,
        python,
      };
      externalFragments.set(manifestPath, fragment);
      addOrdered(fragment);
    }
  }

  for (const fragment of supplementalFragments) addOrdered(fragment);
  for (const fragment of entryFragments) {
    if (used.has(fragment)) continue;
    used.add(fragment);
    ordered.push(fragment);
  }

  const logicBasePath =
    entryFragments.find((fragment) => fragment.externalPath)?.externalPath ??
    entryFragments[0].basePath;

  // Which language the logic is in, from the file names alone. A bundle whose
  // logic is partly each is refused: the two run in separate engines with no
  // shared scope, so concatenating them would silently drop one, and running
  // both would need a message model between them that v1 does not have.
  const pythonFragments = ordered.filter((fragment) => fragment.python);
  const javascriptFragments = ordered.filter(
    (fragment) => !fragment.python && fragment.code.trim() !== ''
  );
  if (pythonFragments.length > 0 && javascriptFragments.length > 0) {
    throw new Error(
      'This app mixes Python and JavaScript logic. They run in separate engines and cannot share names, so an app uses one language for all of its logic.'
    );
  }

  if (pythonFragments.length > 0) {
    // The logic block is left empty on purpose. The document still has one, so
    // the renderer still builds a runtime and the template still calls named
    // functions through it — but the code the runtime compiles is the Python
    // project below, not anything inside the markup.
    const files: Record<string, string> = {};
    const modules: string[] = [];
    for (const fragment of pythonFragments) {
      const path = fragment.externalPath ?? fragment.basePath;
      const module = pythonModuleName(path);
      if (files[module] !== undefined) {
        throw new Error(
          `Two Python logic files are both named ${module}.py; Python imports by module name, so each needs its own`
        );
      }
      files[module] = fragment.code;
      modules.push(module);
    }
    const packages = declaredPythonPackages(textFiles.get('manifest.json'));
    for (const fragment of pythonFragments) {
      for (const name of PYTHON_PACKAGES) {
        if (packages.includes(name) || !importsPackage(fragment.code, name)) continue;
        throw new Error(
          `${fragment.externalPath ?? fragment.basePath} imports ${name}, which an app asks for in manifest.json: "config": { "python": { "packages": ["${name}"] } }`
        );
      }
    }
    return {
      source: `${source}\n<logic>\n</logic>`,
      logicBasePath,
      preIncludedLogicPaths: [],
      languages: ['javascript', 'python'],
      python: { files, modules, packages },
    };
  }

  const preIncluded = new Set<string>();
  for (const fragment of ordered) {
    if (fragment.externalPath && fragment.externalPath !== logicBasePath) {
      preIncluded.add(fragment.externalPath);
    }
  }

  source = `${source}\n<logic>\n${ordered.map((fragment) => fragment.code).join('\n')}\n</logic>`;
  return {
    source,
    logicBasePath,
    preIncludedLogicPaths: [...preIncluded],
    languages: ['javascript'],
  };
}
