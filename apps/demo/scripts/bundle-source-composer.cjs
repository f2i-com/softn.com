/**
 * Node-compatible mirror of @softn/core's bundle source composer.
 *
 * Demo validation must work immediately after `npm ci`, before core has emitted
 * dist files. Keep this small CommonJS mirror covered by regression fixtures so
 * the standalone validator still sees the same single logic block as loaders.
 */

function normalizeRootPath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Unsafe bundle path: ${String(value)}`);
  }
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Unsafe bundle path: ${value}`);
  }

  const parts = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error(`Unsafe bundle path: ${value}`);
    parts.push(part);
  }
  if (parts.length === 0) throw new Error(`Unsafe bundle path: ${value}`);
  return parts.join('/');
}

function resolveBundlePath(basePath, relativePath) {
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

function rewriteLogicImports(source, basePath) {
  const importLine = /^([ \t]*import[ \t]+)(["'])([^"'\r\n]+)\2([ \t]*;?[ \t]*)(\r?)$/gm;
  return source.replace(importLine, (line, prefix, quote, rawPath, suffix, carriage) => {
    if (/^https?:\/\//i.test(rawPath)) return line;
    const importPath =
      rawPath.startsWith('./') || rawPath.startsWith('../')
        ? resolveBundlePath(basePath, rawPath)
        : normalizeRootPath(rawPath);
    return `${prefix}${quote}${importPath}${quote}${suffix}${carriage}`;
  });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function composeBundleSource(textFiles, mainFilePath, manifestLogicPaths = []) {
  const mainPath = normalizeRootPath(mainFilePath);
  const mainUI = textFiles.get(mainPath);
  if (mainUI === undefined) throw new Error(`Main file not found: ${mainFilePath}`);

  const mainFragments = [];
  const supplementalFragments = [];
  const externalFragments = new Map();
  let firstFragment;
  let sawExternalLogic = false;

  const rememberFragment = (fragment) => {
    if (!firstFragment) firstFragment = fragment;
    (fragment.main ? mainFragments : supplementalFragments).push(fragment);
  };

  const collectLogic = (source, uiPath, main) => {
    const logicTag = /<logic\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/logic\s*>)/gi;
    return source.replace(logicTag, (fullTag, attributes, inlineCode) => {
      const src = attributes.match(/\bsrc\s*=\s*(["'])([^"']+)\1/i)?.[2];
      if (src) {
        sawExternalLogic = true;
        const externalPath = resolveBundlePath(uiPath, src);
        if (externalFragments.has(externalPath)) return '';
        const externalSource = textFiles.get(externalPath);
        if (externalSource === undefined) {
          throw new Error(`${externalPath} is referenced by ${uiPath} but is not in the bundle`);
        }
        const fragment = {
          code: rewriteLogicImports(externalSource, externalPath),
          basePath: externalPath,
          externalPath,
          main,
        };
        externalFragments.set(externalPath, fragment);
        rememberFragment(fragment);
        return '';
      }

      if (inlineCode === undefined) return fullTag;
      rememberFragment({ code: rewriteLogicImports(inlineCode, uiPath), basePath: uiPath, main });
      return '';
    });
  };

  const inlineImports = (source, basePath, stack, cache, main) => {
    let nextSource = collectLogic(source, basePath, main);
    const importRegex = /<import\s+(\w+)\s+from=["']([^"']+)["']\s*\/>/g;
    const imports = [];
    let match;
    while ((match = importRegex.exec(nextSource)) !== null) {
      const componentName = match[1];
      const resolvedPath = resolveBundlePath(basePath, match[2]);
      if (stack.has(resolvedPath)) {
        throw new Error(`Circular UI import: ${[...stack, resolvedPath].join(' -> ')}`);
      }
      let content = cache.get(resolvedPath);
      if (content === undefined) {
        const componentSource = textFiles.get(resolvedPath);
        if (componentSource === undefined) {
          throw new Error(`Imported UI file not found: ${resolvedPath}`);
        }
        stack.add(resolvedPath);
        content = inlineImports(componentSource, resolvedPath, stack, cache, false);
        stack.delete(resolvedPath);
        cache.set(resolvedPath, content);
      }
      imports.push({ name: componentName, content });
    }

    nextSource = nextSource.replace(importRegex, '');
    for (const imported of imports) {
      const template = imported.content.replace(/^\/\/[^\n]*\n/gm, '').trim();
      const name = escapeRegex(imported.name);
      nextSource = nextSource.replace(
        new RegExp(`<${name}(?:\\s[^>]*?)?\\s*/>`, 'g'),
        () => template
      );
      nextSource = nextSource.replace(
        new RegExp(`<${name}(?:\\s[^>]*?)?>.*?</${name}\\s*>`, 'gs'),
        () => template
      );
    }
    return nextSource;
  };

  let source = inlineImports(mainUI, mainPath, new Set([mainPath]), new Map(), true);
  if (!firstFragment) return source;

  const entryFragments = mainFragments.length > 0 ? mainFragments : [firstFragment];
  const entrySet = new Set(entryFragments);
  const ordered = [];
  const used = new Set();
  const addOrdered = (fragment) => {
    if (entrySet.has(fragment) || used.has(fragment)) return;
    used.add(fragment);
    ordered.push(fragment);
  };

  if (sawExternalLogic) {
    const seenManifestPaths = new Set();
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
      const fragment = {
        code: rewriteLogicImports(manifestSource, manifestPath),
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

  // Expand imports to make the complete final JavaScript parseable by Node.
  // Check the active stack before the included set: A -> B -> A is a cycle,
  // even though A has necessarily already been included by that point.
  const includedLogic = new Set();
  const expandImports = (logicSource, sourcePath, stack) => {
    const importPattern = /^\s*import\s+["']([^"']+)["']\s*;?\s*$/gm;
    return logicSource.replace(importPattern, (_statement, rawPath) => {
      if (/^https?:\/\//i.test(rawPath)) {
        throw new Error(`Remote logic import cannot be validated offline: ${rawPath}`);
      }
      const importPath = rawPath.startsWith('.')
        ? resolveBundlePath(sourcePath, rawPath)
        : normalizeRootPath(rawPath);
      if (stack.has(importPath)) {
        throw new Error(`Circular logic import: ${[...stack, importPath].join(' -> ')}`);
      }
      if (includedLogic.has(importPath)) return `/* already included: ${rawPath} */`;

      const importedSource = textFiles.get(importPath);
      if (importedSource === undefined) throw new Error(`Missing logic import: ${importPath}`);
      includedLogic.add(importPath);
      stack.add(importPath);
      const expanded = expandImports(importedSource, importPath, stack);
      stack.delete(importPath);
      return expanded;
    });
  };

  const expandedParts = [];
  for (const fragment of ordered) {
    if (fragment.externalPath) {
      if (includedLogic.has(fragment.externalPath)) continue;
      includedLogic.add(fragment.externalPath);
    }
    const stack = fragment.externalPath ? new Set([fragment.externalPath]) : new Set();
    expandedParts.push(expandImports(fragment.code, fragment.basePath, stack));
  }

  source = `${source}\n<logic>\n${expandedParts.join('\n')}\n</logic>`;
  return source;
}

module.exports = { composeBundleSource };
