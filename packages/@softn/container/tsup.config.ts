import { defineConfig } from 'tsup';

export default defineConfig([
  // 1. NPM / Workspace Library Entries (`dist/index.js`, `dist/archive.js`, `dist/esm-linker.js`)
  {
    entry: {
      index: 'src/index.ts',
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
  },
  // 3. Dedicated Web Worker (`/runtime/container-worker.js`)
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
    splitting: false,
    treeshake: true,
    noExternal: ['@softn/bundle-format', 'fflate'],
    external: [/^node:/],
  },
]);
