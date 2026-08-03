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
}

interface LogicFragment {
  code: string;
  /** Path imports in inline logic are relative to, or the external file path. */
  basePath: string;
  /** Present when this fragment came from a standalone .logic file. */
  externalPath?: string;
  /** Main-document logic runs after helpers/component logic. */
  main: boolean;
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
        const fragment: LogicFragment = {
          code: rewriteBundleLogicImports(externalSource, externalPath),
          basePath: externalPath,
          externalPath,
          main,
        };
        externalFragments.set(externalPath, fragment);
        rememberFragment(fragment);
        return '';
      }

      // A self-closing <logic /> without src is malformed but harmless; retain
      // it so the parser can surface the author's input rather than invent code.
      if (inlineCode === undefined) return fullTag;
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
    return { source, preIncludedLogicPaths: [] };
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
      const fragment: LogicFragment = {
        code: rewriteBundleLogicImports(manifestSource, manifestPath),
        basePath: manifestPath,
        externalPath: manifestPath,
        main: false,
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
  };
}
