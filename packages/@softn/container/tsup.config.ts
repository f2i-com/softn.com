import fs from 'node:fs';
import { transformSync } from 'esbuild';
import { defineConfig } from 'tsup';

const GUEST_SOURCE_FILE_RE =
  /(?:^|[\\/])(?:guest-(?:canvas-and-ext|web-apis|browser-globals|indexeddb|webgl|react-vendor|three-native|worker-scope|vendors)|shell-source|esm-linker)\.ts$/;

/**
 * Minify embedded JS inside `String.raw\`...\`` guest prelude sources at build time.
 * Strips ~300+ KB of comments, whitespace, and local identifiers from `container-worker.js`
 * and `worker-chunks/`, cutting both Worker download size and ZIPP VM startup parsing time
 * while preserving top-level bindings (`globalThis.__softn*`, `export` names, and `eval` scopes).
 */
function minifyGuestSourceLiterals(source: string, filePath: string): string {
  return source.replace(/String\.raw`([\s\S]*?)`/g, (full, body: string) => {
    if (body.length < 256 || body.includes('${')) return full;
    const hasEntities = body.includes('@ENTITIES@');
    const prep = hasEntities ? body.replace(/@ENTITIES@/g, '__SOFTN_ENTITIES_PLACEHOLDER__') : body;
    try {
      const res = transformSync(prep, {
        loader: 'js',
        minifyWhitespace: true,
        minifySyntax: true,
        minifyIdentifiers: true,
        target: 'es2020',
      });
      const out = hasEntities
        ? res.code.replace(/__SOFTN_ENTITIES_PLACEHOLDER__/g, '@ENTITIES@')
        : res.code;
      return JSON.stringify(out);
    } catch (err) {
      console.warn(`[container] Failed to minify guest source literal in ${filePath}:`, err instanceof Error ? err.message : String(err));
      return full;
    }
  });
}

const minifyGuestSourcesPlugin = {
  name: 'softn-minify-guest-sources',
  setup(build: { onLoad: (opts: { filter: RegExp }, cb: (args: { path: string }) => { contents: string; loader: 'ts' }) => void }) {
    build.onLoad({ filter: GUEST_SOURCE_FILE_RE }, (args) => {
      const raw = fs.readFileSync(args.path, 'utf8');
      return { contents: minifyGuestSourceLiterals(raw, args.path), loader: 'ts' };
    });
  },
};

export default defineConfig([
  // 1. NPM / Workspace Library Entries (`dist/index.js`, `dist/mount.js`, `dist/archive.js`, `dist/esm-linker.js`)
  {
    entry: {
      index: 'src/index.ts',
      mount: 'src/mount.ts',
      archive: 'src/archive.ts',
      'esm-linker': 'src/esm-linker.ts',
    },
    platform: 'browser',
    format: ['esm'],
    dts: { compilerOptions: { rootDir: '..' } },
    clean: true,
    sourcemap: true,
    minify: true,
    splitting: true,
    treeshake: true,
    noExternal: ['@softn/bundle-format', 'fflate'],
    external: ['three', /^three\//, /^node:/],
    esbuildPlugins: [minifyGuestSourcesPlugin],
  },
  // 2. Drop-in Browser Runtime (`/runtime/softn.js` + lazy chunks in `/runtime/`)
  // Works directly via `<script type="module" src="/runtime/softn.js"></script>` on any static server!
  {
    entry: {
      softn: 'src/index.ts',
    },
    outDir: 'dist/runtime',
    platform: 'browser',
    format: ['esm'],
    dts: false,
    clean: false,
    sourcemap: true,
    minify: true,
    splitting: true,
    treeshake: true,
    noExternal: ['@softn/bundle-format', 'fflate'],
    external: ['three', /^three\//, /^node:/],
    esbuildPlugins: [minifyGuestSourcesPlugin],
  },
  // 3. Dedicated Frontend Web Worker (`/runtime/container-worker.js` + lazy `/runtime/worker-chunks/*.js`)
  {
    entry: {
      'container-worker': 'src/worker-entry.ts',
    },
    outDir: 'dist/runtime',
    platform: 'browser',
    format: ['esm'],
    dts: false,
    clean: false,
    sourcemap: true,
    minify: true,
    splitting: true,
    treeshake: true,
    noExternal: ['@softn/bundle-format', 'fflate'],
    external: [/^node:/],
    esbuildPlugins: [minifyGuestSourcesPlugin],
    esbuildOptions(options) {
      options.chunkNames = 'worker-chunks/[name]-[hash]';
    },
  },
  // 4. Dedicated Full-Stack Backend & SQLite Web Worker (`/runtime/backend-worker.js`)
  {
    entry: {
      'backend-worker': 'src/backend-worker-entry.ts',
    },
    outDir: 'dist/runtime',
    platform: 'browser',
    format: ['esm'],
    dts: false,
    clean: false,
    sourcemap: true,
    minify: true,
    splitting: false,
    treeshake: true,
    noExternal: ['@softn/bundle-format', 'fflate'],
    external: [/^node:/],
  },
]);
