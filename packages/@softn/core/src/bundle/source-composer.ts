/**
 * Shared bundle source composition for the browser and desktop loaders.
 *
 * A SoftN document can acquire logic from its main UI, imported UI components,
 * and manifest-listed helper files. The parser intentionally exposes one logic
 * block, so loaders must combine those inputs before parsing. This module keeps
 * that operation identical across hosts and canonicalizes relative imports
 * while each fragment's real source path is still known.
 */

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
  python?: { files: Record<string, string>; modules: string[] };
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
 * logic block without borrowing the entry file's directory.
 */
export function rewriteBundleLogicImports(source: string, basePath: string): string {
  const importLine = /^([ \t]*import[ \t]+)(["'])([^"'\r\n]+)\2([ \t]*;?[ \t]*)(\r?)$/gm;
  return source.replace(
    importLine,
    (line, prefix: string, quote: string, rawPath: string, suffix: string, carriage: string) => {
      if (rawPath.startsWith('http://') || rawPath.startsWith('https://')) return line;

      let path: string;
      if (rawPath.startsWith('./') || rawPath.startsWith('../')) {
        path = resolveBundlePath(basePath, rawPath);
      } else {
        path = normalizeRootPath(rawPath);
      }
      return `${prefix}${quote}${path}${quote}${suffix}${carriage}`;
    }
  );
}

/** Escape a component name before embedding it in a regular expression. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Inline a bundle's UI component graph and combine every discovered logic
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

  const mainFragments: LogicFragment[] = [];
  const supplementalFragments: LogicFragment[] = [];
  const externalFragments = new Map<string, LogicFragment>();
  let firstFragment: LogicFragment | undefined;
  let sawExternalLogic = false;

  const rememberFragment = (fragment: LogicFragment): void => {
    firstFragment ??= fragment;
    (fragment.main ? mainFragments : supplementalFragments).push(fragment);
  };

  const collectLogic = (source: string, uiPath: string, main: boolean): string => {
    const logicTag = /<logic\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/logic\s*>)/gi;
    return source.replace(logicTag, (fullTag, attributes: string, inlineCode?: string) => {
      const src = attributes.match(/\bsrc\s*=\s*(["'])([^"']+)\1/i)?.[2];
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
      const fragment: LogicFragment = {
        code: rewriteBundleLogicImports(inlineCode, uiPath),
        basePath: uiPath,
        main,
      };
      rememberFragment(fragment);
      return '';
    });
  };

  const inlineImports = (
    source: string,
    basePath: string,
    stack: Set<string>,
    cache: Map<string, string>,
    main: boolean
  ): string => {
    let nextSource = collectLogic(source, basePath, main);
    const importRegex = /<import\s+(\w+)\s+from=["']([^"']+)["']\s*\/>/g;
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

    nextSource = nextSource.replace(/<import\s+\w+\s+from=["'][^"']+["']\s*\/>\n?/g, '');
    for (const imported of imports) {
      const template = imported.content.replace(/^\/\/[^\n]*\n/gm, '').trim();
      const name = escapeRegex(imported.name);
      const selfClosing = new RegExp(`<${name}(?:\\s[^>]*?)?\\s*/>`, 'g');
      const paired = new RegExp(`<${name}(?:\\s[^>]*?)?>.*?</${name}\\s*>`, 'gs');
      nextSource = nextSource.replace(selfClosing, () => template);
      nextSource = nextSource.replace(paired, () => template);
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
    return {
      source: `${source}\n<logic>\n</logic>`,
      logicBasePath,
      preIncludedLogicPaths: [],
      languages: ['javascript', 'python'],
      python: { files, modules },
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
