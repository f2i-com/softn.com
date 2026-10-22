/**
 * A `.logic` file's `import "./other.logic"` lines, inlined: the engine
 * compiles one source, so each imported file is fetched through the host's
 * resolver and put where its import was, its own imports first.
 */

import { moduleSyntaxAsScript } from './module-syntax';

/** Where imported files come from, and which are in the compilation already. */
export interface LogicImports {
  /** The file at a bundle-relative path, or null when there is none. */
  resolver: (path: string) => Promise<string | null>;
  /**
   * Every `.logic` path already part of this compilation — whether the host
   * concatenated it or an earlier import pulled it in. Inlining adds to it.
   */
  included: Set<string>;
}

/**
 * Resolve import statements in .logic code by inlining imported files.
 * Handles `import "./path.logic"` statements by fetching the imported code
 * via the resolver and recursively resolving nested imports. `expanding` is
 * the chain of files being inlined, from the entry file down.
 */
export async function inlineLogicImports(
  code: string,
  imports: LogicImports,
  expanding: Set<string>,
  currentPath?: string
): Promise<string> {
  // Match import statements: import "./path.logic" or import './path.logic'.
  // Spaces and tabs only, never a line's end: `^\s*` under the `m` flag ran
  // across every blank line after each line start, which made a file of blank
  // lines cost the square of its length, and an import's match took the blank
  // lines around it with it.
  const importRegex = /^[ \t]*import[ \t]+["']([^"'\n]+)["'][ \t]*;?[ \t]*$/gm;
  const parts: string[] = [];
  let lastIndex = 0;
  let match;

  while ((match = importRegex.exec(code)) !== null) {
    // Add code before this import
    parts.push(code.slice(lastIndex, match.index));

    const importPath = match[1];
    const resolvedPath = resolveImportPath(importPath, currentPath);

    // A file already in this compilation is included once, not twice: the
    // result is a single translation unit, and re-inlining a file would
    // redeclare every class and variable in it — a SyntaxError to the VM.
    // Two files importing a common third is normal, so this is a skip.
    if (imports.included.has(resolvedPath)) {
      parts.push(`/* already included: ${importPath} */`);
    } else if (expanding.has(resolvedPath)) {
      // Still being expanded further up the chain, so it genuinely cycles.
      throw new Error(
        `Circular import detected: "${resolvedPath}" is already in the import chain: ${[...expanding].join(' → ')} → ${resolvedPath}`
      );
    } else {
      expanding.add(resolvedPath);
      imports.included.add(resolvedPath);
      try {
        const source = await imports.resolver(resolvedPath);
        if (source != null) {
          // Recursively resolve imports in the imported code
          const resolved = await inlineLogicImports(moduleSyntaxAsScript(source), imports, expanding, resolvedPath);
          parts.push(resolved);
        } else {
          parts.push(`/* import not found: ${importPath} */`);
        }
      } catch (e) {
        console.error(`[SoftN] Error resolving import "${importPath}":`, e);
        parts.push(`/* import error: ${importPath} */`);
      } finally {
        // Off the ancestor chain — it stays in `included`, so a later
        // sibling import of the same file skips rather than throws.
        expanding.delete(resolvedPath);
      }
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining code after last import
  parts.push(code.slice(lastIndex));
  return parts.join('\n');
}

/**
 * Resolve a relative import path against the current file's directory.
 */
export function resolveImportPath(importPath: string, currentPath?: string): string {
  // Absolute paths, URLs — return as-is
  if (
    importPath.startsWith('http://') ||
    importPath.startsWith('https://') ||
    importPath.startsWith('/')
  ) {
    return importPath;
  }
  // Not relative — return as-is
  if (!importPath.startsWith('./') && !importPath.startsWith('../')) {
    return importPath;
  }
  // No base path — return as-is
  if (!currentPath) {
    return importPath;
  }
  // Resolve relative to current file's directory
  const baseParts = currentPath.split('/');
  baseParts.pop(); // remove filename to get directory
  const importParts = importPath.split('/');
  for (const part of importParts) {
    if (part === '.') continue;
    if (part === '..') {
      baseParts.pop();
    } else {
      baseParts.push(part);
    }
  }
  return baseParts.join('/');
}
