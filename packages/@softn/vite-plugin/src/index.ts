/**
 * Vite Plugin for SoftN UI Language
 *
 * Transforms .softn files into React components at build time.
 */

import type { Plugin } from 'vite';
import { parse } from '@softn/core';
import type { SoftNDocument } from '@softn/core';

/**
 * Source map generator for SoftN transformations
 */
interface SourceMapGenerator {
  mappings: string;
  sources: string[];
  sourcesContent: string[];
  names: string[];
}

interface GeneratedSourceMap extends SourceMapGenerator {
  version: 3;
  file: string;
}

interface CachedTransform {
  hash: string;
  output: string;
  map: GeneratedSourceMap | null;
}

interface SoftNTransformResult {
  code: string;
  map: GeneratedSourceMap | null;
}

/**
 * Encode a VLQ (Variable Length Quantity) value
 * Used for source map mappings encoding
 */
function encodeVLQ(value: number): string {
  const VLQ_CONTINUATION_BIT = 32;
  const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  let encoded = '';
  let vlq = value < 0 ? (-value << 1) + 1 : value << 1;

  do {
    let digit = vlq & 31;
    vlq >>>= 5;
    if (vlq > 0) {
      digit |= VLQ_CONTINUATION_BIT;
    }
    encoded += BASE64_CHARS[digit];
  } while (vlq > 0);

  return encoded;
}

/**
 * Generate source map for transformed SoftN code
 */
function generateSourceMap(
  sourceCode: string,
  generatedCode: string,
  sourceFile: string,
  document: SoftNDocument
): SourceMapGenerator {
  const lines = generatedCode.split('\n');
  const sourceLines = sourceCode.split('\n');
  const mappings: string[] = [];

  let prevGeneratedColumn = 0;
  let prevSourceLine = 0;
  let prevSourceColumn = 0;

  for (let genLine = 0; genLine < lines.length; genLine++) {
    const line = lines[genLine];
    const segments: string[] = [];

    // Map based on content patterns
    let sourceLine = -1;

    // Check if this generated line corresponds to script content
    if (document.script?.code) {
      const scriptMatch = findMatchInSource(line.trim(), document.script.code);
      if (scriptMatch !== -1) {
        // Find the line number in original source where script starts
        const scriptStartLine = findScriptStartLine(sourceCode);
        sourceLine = scriptStartLine + scriptMatch;
      }
    }

    // Check if this generated line corresponds to template elements
    if (sourceLine === -1) {
      sourceLine = findLineInSource(line.trim(), sourceLines);
    }

    if (sourceLine !== -1 && line.trim().length > 0) {
      // Create a mapping for the start of this line
      const generatedColumn = 0;
      const sourceColumn = 0;

      // Reset column for new line
      const colDiff = generatedColumn - prevGeneratedColumn;
      const lineDiff = sourceLine - prevSourceLine;
      const sourceColDiff = sourceColumn - prevSourceColumn;

      segments.push(
        encodeVLQ(colDiff) + // Generated column (relative)
          encodeVLQ(0) + // Source file index (always 0)
          encodeVLQ(lineDiff) + // Source line (relative)
          encodeVLQ(sourceColDiff) // Source column (relative)
      );

      prevGeneratedColumn = generatedColumn;
      prevSourceLine = sourceLine;
      prevSourceColumn = sourceColumn;
    }

    mappings.push(segments.join(','));
    prevGeneratedColumn = 0; // Reset for each new line
  }

  return {
    mappings: mappings.join(';'),
    sources: [sourceFile],
    sourcesContent: [sourceCode],
    names: [],
  };
}

/**
 * Find where script block starts in source
 */
function findScriptStartLine(source: string): number {
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('<script>')) {
      return i + 1; // Return next line (inside script)
    }
  }
  return 0;
}

/**
 * Find matching content in script block
 */
function findMatchInSource(generatedLine: string, scriptCode: string): number {
  const scriptLines = scriptCode.split('\n');
  const trimmedGen = generatedLine.trim();

  // Skip generated boilerplate
  if (
    trimmedGen.startsWith('const [') ||
    trimmedGen.startsWith('const setState') ||
    trimmedGen.startsWith('const __')
  ) {
    return -1;
  }

  for (let i = 0; i < scriptLines.length; i++) {
    const scriptLine = scriptLines[i].trim();
    if (scriptLine && trimmedGen.includes(scriptLine)) {
      return i;
    }
  }
  return -1;
}

/**
 * Find a line in the source that matches generated content
 */
function findLineInSource(generatedLine: string, sourceLines: string[]): number {
  const trimmedGen = generatedLine.trim();

  // Skip import/boilerplate lines
  if (
    trimmedGen.startsWith('import ') ||
    trimmedGen.startsWith('export ') ||
    trimmedGen.startsWith('const ') ||
    trimmedGen.startsWith('//') ||
    trimmedGen === '' ||
    trimmedGen === '{' ||
    trimmedGen === '}' ||
    trimmedGen === ');'
  ) {
    return -1;
  }

  // Look for component usage like <Button, Stack, etc.
  const tagMatch = trimmedGen.match(/<(\w+)/);
  if (tagMatch) {
    const tagName = tagMatch[1];
    for (let i = 0; i < sourceLines.length; i++) {
      if (sourceLines[i].includes(`<${tagName}`)) {
        return i;
      }
    }
  }

  return -1;
}

export interface SoftNPluginOptions {
  /**
   * Include patterns for files to transform
   * @default [/\.softn$/]
   */
  include?: (string | RegExp)[];

  /**
   * Exclude patterns for files to skip
   * @default [/node_modules/]
   */
  exclude?: (string | RegExp)[];

  /**
   * Enable hot module replacement
   * @default true
   */
  hmr?: boolean;

  /**
   * Enable source maps for debugging
   * @default true
   */
  sourceMaps?: boolean;

  /**
   * Enable caching for faster rebuilds
   * @default true
   */
  cache?: boolean;

  /**
   * Enable verbose logging
   * @default false
   */
  verbose?: boolean;
}

// Simple hash function for cache invalidation
function hashCode(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

/**
 * Create the SoftN Vite plugin
 */
export default function softnPlugin(options: SoftNPluginOptions = {}): Plugin {
  const {
    include = [/\.softn$/],
    exclude = [/node_modules/],
    hmr = true,
    sourceMaps = true,
    cache = true,
    verbose = false,
  } = options;

  // eslint-disable-next-line no-console -- build-time output, printed only when the plugin is given `verbose: true`
  const log = verbose ? console.log.bind(console, '[softn]') : () => {};
  // Cache per plugin instance: output depends on options such as HMR and source
  // maps, so a module-global cache let one Vite config poison another one.
  const documentCache = new Map<string, CachedTransform>();

  return {
    name: 'vite-plugin-softn',

    /**
     * Resolve .softn file imports
     */
    resolveId(source, _importer) {
      // Handle .softn imports
      if (source.endsWith('.softn')) {
        return null; // Let Vite resolve the file normally
      }
      return null;
    },

    /**
     * Transform .softn files to JavaScript modules
     */
    transform(code: string, id: string): SoftNTransformResult | null {
      // Check if this file should be processed
      if (!shouldTransform(id, include, exclude)) {
        return null;
      }

      const startTime = performance.now();
      const codeHash = hashCode(code);

      // Check cache first
      if (cache) {
        const cached = documentCache.get(id);
        if (cached && cached.hash === codeHash) {
          log(`Cache hit for ${id}`);
          return {
            code: cached.output,
            map: cached.map,
          };
        }
      }

      try {
        // Parse the .softn source
        const document = parse(code);

        // Generate JavaScript module
        const output = generateModule(document, id, hmr);

        const elapsed = (performance.now() - startTime).toFixed(2);
        log(`Transformed ${id} in ${elapsed}ms`);

        // Generate source map if enabled
        let map: GeneratedSourceMap | null = null;
        if (sourceMaps) {
          const sourceMapData = generateSourceMap(code, output, id, document);
          map = {
            version: 3,
            file: `${getSourceFileName(id)}.js`,
            sources: sourceMapData.sources,
            sourcesContent: sourceMapData.sourcesContent,
            names: sourceMapData.names,
            mappings: sourceMapData.mappings,
          };
        }

        if (cache) {
          documentCache.set(id, { hash: codeHash, output, map });
        }

        return {
          code: output,
          map,
        };
      } catch (error) {
        const err = error as Error;

        // Try to extract line/column info from error
        let lineInfo = '';
        const lineMatch = err.message.match(/line (\d+)/i);
        const colMatch = err.message.match(/column (\d+)/i);
        if (lineMatch) {
          lineInfo = ` at line ${lineMatch[1]}`;
          if (colMatch) {
            lineInfo += `:${colMatch[1]}`;
          }
        }

        this.error({
          id,
          message: `SoftN parse error${lineInfo}: ${err.message}`,
          frame: extractErrorFrame(code, lineMatch ? parseInt(lineMatch[1], 10) : undefined),
        });
        return null;
      }
    },

    /**
     * Handle hot module replacement
     */
    handleHotUpdate({ file, modules }) {
      if (file.endsWith('.softn') && hmr) {
        // Invalidate cache for this file
        if (cache) {
          documentCache.delete(file);
          log(`Cache invalidated for ${file}`);
        }
        // Invalidate the module to trigger re-transform
        return modules;
      }
      return;
    },

    /**
     * Clear cache on build start
     */
    buildStart() {
      documentCache.clear();
    },
  };
}

/**
 * Extract a code frame around an error line for better error messages
 */
function extractErrorFrame(code: string, errorLine?: number): string | undefined {
  if (!errorLine) return undefined;

  const lines = code.split('\n');
  const start = Math.max(0, errorLine - 3);
  const end = Math.min(lines.length, errorLine + 2);

  const frameLines: string[] = [];
  for (let i = start; i < end; i++) {
    const lineNum = (i + 1).toString().padStart(4, ' ');
    const marker = i + 1 === errorLine ? ' > ' : '   ';
    frameLines.push(`${marker}${lineNum} | ${lines[i]}`);
    if (i + 1 === errorLine) {
      frameLines.push(`       | ${'~'.repeat(lines[i].length)}`);
    }
  }

  return frameLines.join('\n');
}

/**
 * Check if a file should be transformed
 */
function shouldTransform(
  id: string,
  include: (string | RegExp)[],
  exclude: (string | RegExp)[]
): boolean {
  // Check excludes first
  for (const pattern of exclude) {
    if (typeof pattern === 'string') {
      if (id.includes(pattern)) return false;
    } else if (testPattern(pattern, id)) {
      return false;
    }
  }

  // Check includes
  for (const pattern of include) {
    if (typeof pattern === 'string') {
      if (id.includes(pattern)) return true;
    } else if (testPattern(pattern, id)) {
      return true;
    }
  }

  return false;
}

/** Test user-supplied global/sticky regexes without leaking their lastIndex. */
function testPattern(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  const matches = pattern.test(value);
  pattern.lastIndex = 0;
  return matches;
}

/**
 * Generate a JavaScript module from a parsed SoftN document
 */
function generateModule(document: SoftNDocument, id: string, hmr: boolean): string {
  const componentName = getComponentName(id);

  // Serialize the AST for runtime use
  const serializedDoc = JSON.stringify(document, null, 2);

  // Extract script code for analysis
  const scriptCode = document.script?.code ?? '';

  // Parse script to extract state variables and functions
  const { stateVars, functions } = analyzeScript(scriptCode);

  // Generate the module code
  let code = `
import { useState, useCallback, useMemo } from 'react';
import { getDefaultEngine } from '@softn/core';
import { ensureRuntimeComponents } from '@softn/components/lazy';

// The built-in components, as the runtimes register them: the start-up set
// now, every other component (the light groups, charts, editors, Scene3D with
// Three.js, media) fetched the first time a page draws it, so an app carries
// only what it uses.
ensureRuntimeComponents();

// Parsed SoftN document
const __softn_document__ = ${serializedDoc};

// Component: ${componentName}
export default function ${componentName}(props) {
  // State management
  ${generateStateHooks(stateVars)}

  // State setter helper
  const setState = useCallback((path, value) => {
    const [root, ...rest] = path.split('.');
    const setter = __setters__[root];
    if (setter) {
      if (rest.length === 0) {
        setter(value);
      } else {
        setter(prev => {
          const newState = { ...prev };
          let current = newState;
          for (let i = 0; i < rest.length - 1; i++) {
            current[rest[i]] = { ...current[rest[i]] };
            current = current[rest[i]];
          }
          current[rest[rest.length - 1]] = value;
          return newState;
        });
      }
    }
  }, []);

  // Setters map
  const __setters__ = useMemo(() => ({
    ${stateVars.map((v) => `${v.name}: set${capitalize(v.name)}`).join(',\n    ')}
  }), [${stateVars.map((v) => `set${capitalize(v.name)}`).join(', ')}]);

  // Functions from script
  ${generateFunctions(functions, stateVars)}

  // Render context
  const context = useMemo(() => ({
    state: { ${stateVars.map((v) => v.name).join(', ')} },
    setState,
    data: {},
    props: props || {},
    computed: {},
    functions: { ${functions.map((f) => f.name).join(', ')} },
  }), [${stateVars.map((v) => v.name).join(', ')}, setState, props, ${functions.map((f) => f.name).join(', ')}]);

  // Get the engine
  const engine = useMemo(() => getDefaultEngine(), []);

  // Render the document
  return engine.render(__softn_document__, context);
}

${componentName}.displayName = '${componentName}';
`;

  // Add HMR support
  if (hmr) {
    code += `
// Hot module replacement
if (import.meta.hot) {
  import.meta.hot.accept();
}
`;
  }

  return code;
}

/**
 * Get component name from file path
 */
function getComponentName(id: string): string {
  const fileName = getSourceFileName(id);
  const name = fileName.replace(/\.softn$/i, '');
  const pascalName = name
    .split(/[^a-zA-Z0-9_$]+/)
    .filter(Boolean)
    .map((part) => capitalize(part))
    .join('');

  if (!pascalName) return 'SoftNComponent';
  return /^[a-zA-Z_$]/.test(pascalName) ? pascalName : `SoftN${pascalName}`;
}

/** File name without Vite query/hash suffixes, on POSIX or Windows paths. */
function getSourceFileName(id: string): string {
  const cleanId = id.split(/[?#]/, 1)[0].replace(/\\/g, '/');
  return cleanId.split('/').pop() || 'Component.softn';
}

/**
 * Capitalize first letter
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Analyze script block to extract state and functions
 */
interface StateVar {
  name: string;
  initialValue: string;
}

interface FunctionDef {
  name: string;
  params: string;
  body: string;
  isAsync: boolean;
}

interface ScriptShape {
  /** The brace depth at the start of each line (as `split('\n')` cuts them). */
  lineDepths: number[];
  /** For each `{` of code, the index of the `}` that closes it. */
  closeOf: Map<number, number>;
}

/**
 * Where the script's braces open and close, counting only braces of code:
 * those inside strings, template text and comments are passed over. A quote
 * string ends at its line's end, so a stray quote (one in a regex literal, say)
 * cannot hide the rest of the script.
 */
function scanScript(code: string): ScriptShape {
  const lineDepths = [0];
  const closeOf = new Map<number, number>();
  const opens: number[] = [];
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '\n') {
      lineComment = false;
      if (quote !== '`') quote = '';
      lineDepths.push(opens.length);
      continue;
    }
    if (lineComment) continue;
    if (blockComment) {
      if (c === '*' && code[i + 1] === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (c === '\\') {
        if (code[i + 1] === '\n') lineDepths.push(opens.length);
        i++;
      } else if (c === quote) {
        quote = '';
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '/' && code[i + 1] === '/') lineComment = true;
    else if (c === '/' && code[i + 1] === '*') {
      blockComment = true;
      i++;
    } else if (c === '{') opens.push(i);
    else if (c === '}') {
      const open = opens.pop();
      if (open !== undefined) closeOf.set(open, i);
    }
  }
  return { lineDepths, closeOf };
}

function analyzeScript(code: string): {
  stateVars: StateVar[];
  functions: FunctionDef[];
} {
  const stateVars: StateVar[] = [];
  const functions: FunctionDef[] = [];

  // Simple regex-based parsing for now
  // TODO: Use FormLogic parser for proper AST analysis

  // Only the script's own declarations count: a `let` or a function inside a
  // function body (or any other block) belongs to that body. Taken for state,
  // `let next = count + 1;` in a function got a hook of its own and was then
  // rewritten into `let setNext(count + 1);`.
  const { lineDepths, closeOf } = scanScript(code);
  const lineStarts = new Map<number, number>();
  let offset = 0;
  code.split('\n').forEach((line, index) => {
    lineStarts.set(offset, index);
    offset += line.length + 1;
    if (lineDepths[index] !== 0) return;
    // State: let foo = value;
    const match = /^\s*let\s+(\w+)\s*=\s*(.+?);?\s*$/.exec(line);
    // Skip if it looks like a computed value ($:)
    if (match && !match[1].startsWith('$')) {
      stateVars.push({ name: match[1], initialValue: match[2].trim() });
    }
  });

  // Function declarations: function foo(params) { body }. The body runs to the
  // brace that closes it, not to the first line that starts with `}` (which cut
  // a function at the end of a multi-line object literal or an inner block).
  const header = /^[ \t]*(async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*\{/gm;
  let match;
  while ((match = header.exec(code)) !== null) {
    const line = lineStarts.get(match.index);
    if (line === undefined || lineDepths[line] !== 0) continue;
    const open = match.index + match[0].length - 1;
    const close = closeOf.get(open);
    if (close === undefined) continue;
    const [, asyncKeyword, name, params] = match;
    functions.push({
      name,
      params: params.trim(),
      body: code.slice(open + 1, close).trim(),
      isAsync: !!asyncKeyword,
    });
    header.lastIndex = close + 1;
  }

  return { stateVars, functions };
}

/**
 * Generate useState hooks for state variables
 */
function generateStateHooks(stateVars: StateVar[]): string {
  return stateVars
    .map((v) => {
      // Try to parse the initial value
      const initialValue = v.initialValue;

      // Handle common cases
      if (initialValue === 'true' || initialValue === 'false') {
        // boolean
      } else if (/^\d+$/.test(initialValue)) {
        // number
      } else if (/^".*"$/.test(initialValue) || /^'.*'$/.test(initialValue)) {
        // string - keep as is
      } else if (initialValue.startsWith('{') || initialValue.startsWith('[')) {
        // object or array - keep as is
      } else {
        // Default to the raw value
      }

      return `const [${v.name}, set${capitalize(v.name)}] = useState(${initialValue});`;
    })
    .join('\n  ');
}

/**
 * Generate function definitions with state access
 */
function generateFunctions(functions: FunctionDef[], stateVars: StateVar[]): string {
  return functions
    .map((f) => {
      // Replace state variable assignments with setState calls
      let body = f.body;

      // Replace `foo = value` with `setFoo(value)` for state vars. The `=`
      // must be an assignment's: not the first of `==` or `===`, which made
      // `if (foo === 0) { foo = 1; }` into `setFoo(== 0) { foo = 1);`, and
      // not the `=>` of an arrow function whose parameter has the same name.
      // The name must stand alone, so `other.foo = 1` is left to `other`, and
      // `let foo = 1` in a function declares a local, which is not rewritten
      // (into `let setFoo(1);`, which is not JavaScript).
      for (const v of stateVars) {
        const assignRegex = new RegExp(
          `(?<![\\w$.])(?<!\\b(?:let|const|var)\\s+)${v.name}\\s*=(?![=>])\\s*(.+?)(?:;|$)`,
          'g'
        );
        body = body.replace(assignRegex, (_, value) => {
          return `set${capitalize(v.name)}(${value.trim()});`;
        });
      }

      // Replace xdb calls with the context-based calls
      body = body.replace(/\bxdb\./g, 'props.xdb.');

      return `const ${f.name} = useCallback(${f.isAsync ? 'async ' : ''}(${f.params}) => {
    ${body}
  }, [${[...stateVars.map((v) => v.name), 'props'].join(', ')}]);`;
    })
    .join('\n\n  ');
}

// Named export
export { softnPlugin };
