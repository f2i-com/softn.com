import { compiledSourcePath, GENERATED_SOURCE_HEADER, generatedFrameworkPath, isGeneratedSourceModule, sourceModuleHeader } from '@softn/bundle-format/source-modules';
import { readWebImportMap } from '@softn/bundle-format/web-imports';
import { keepSourceCompiler } from './keepSourceCompiler';

type Format = 'jsx' | 'vue';
type Compiler = (source: string, path: string) => string;
type CompilerModule = { compile: Compiler; frameworkSource: () => Promise<string> };

// Preview, export and Studio's source check can ask for the same component.
// Keep only a bounded set of recent transforms, keyed by all compilation inputs.
const recent = new Map<string, { source: string; code: string; size: number }>();
const MAX_CACHED_CHARS = 512 * 1024;
let recentChars = 0;

async function compileModule(compiler: Compiler, source: string, path: string): Promise<string> {
  const previous = recent.get(path);
  if (previous?.source === source) {
    recent.delete(path);
    recent.set(path, previous);
    return previous.code;
  }
  const body = compiler(source, path);
  const code = await sourceModuleHeader(path, source) + body;
  // Another preview/export may have finished while the digest was pending.
  const cached = recent.get(path);
  if (cached) {
    recentChars -= cached.size;
    recent.delete(path);
  }
  const size = path.length + source.length + code.length;
  if (size <= MAX_CACHED_CHARS) {
    // Insertion order is the order of last use.
    for (const [key, entry] of recent) {
      if (recentChars + size <= MAX_CACHED_CHARS && recent.size < 64) break;
      recentChars -= entry.size;
      recent.delete(key);
    }
    recent.set(path, { source, code, size });
    recentChars += size;
  }
  return code;
}

// Each import must have its own Vite preload boundary. Combining the imports
// into a conditional lets the production bundler preload both toolchains.
const compilerLoaders = {
  jsx: () => import('./sourceCompilers/jsx'),
  vue: () => import('./sourceCompilers/vue'),
};

function loadCompiler(format: Format): Promise<CompilerModule> {
  // A first-time or storage-restricted editor might have no controlling worker
  // yet. The source can already run while the worker saves it for the next visit.
  void keepSourceCompiler(format).catch((error) => console.warn('Could not save the source compiler for offline editing.', error));
  return compilerLoaders[format]();
}

function projectImportMaps(files: ReadonlyMap<string, string>) {
  let imports: unknown;
  try {
    imports = JSON.parse(files.get('manifest.json') ?? '{}')?.imports;
  } catch {
    // The editor reports malformed manifests. Never assume a missing mapping.
  }
  const pages = [...files].filter(([path]) => /\.html?$/i.test(path));
  if (!pages.length) return [readWebImportMap('', imports)];
  return pages.map(([, html]) => readWebImportMap(html, imports));
}

function mapsFramework(map: Record<string, string>, framework: 'react' | 'vue'): boolean {
  const names = framework === 'react' ? ['react', 'react-dom/client'] : ['vue'];
  return names.every(name => map[name] || Object.keys(map).some(key => key.endsWith('/') && name.startsWith(key) && map[key]));
}

/** Build runnable modules beside the authored files. Runtime gives each module its
 * source file's URL, so imports and asset paths still resolve inside the project. */
export async function prepareWebSourceFiles(files: ReadonlyMap<string, string>): Promise<Map<string, string>> {
  const output = new Map(files);
  for (const [path, content] of files) {
    if (isGeneratedSourceModule(path, content)) output.delete(path);
  }
  const compilers = new Map<Format, CompilerModule>();
  for (const [path, source] of files) {
    const target = compiledSourcePath(path);
    if (!target) continue;
    if (output.has(target)) throw new Error(`Rename ${target} to make room for the preview of ${path}.`);
    const format = /\.jsx$/i.test(path) ? 'jsx' : 'vue';
    try {
      let compiler = compilers.get(format);
      if (!compiler) {
        compiler = await loadCompiler(format);
        compilers.set(format, compiler);
      }
      output.set(target, await compileModule(compiler.compile, source, path));
    } catch (error) {
      throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  let maps: ReturnType<typeof projectImportMaps> | undefined;
  for (const [format, compiler] of compilers) {
    const framework = format === 'jsx' ? 'react' : 'vue';
    if (files.has(`vendor/${framework}.js`)) continue;
    maps ??= projectImportMaps(files);
    if (maps.every(map => mapsFramework(map, framework))) continue;
    const target = generatedFrameworkPath(framework);
    if (output.has(target)) throw new Error(`Rename ${target} to make room for the project's ${framework} library.`);
    output.set(target, GENERATED_SOURCE_HEADER + await compiler.frameworkSource());
  }
  return output;
}
