import { defineConfig } from 'tsup';

export default defineConfig({
  // The object form pins the output names — dist/lazy.js, dist/scene3d.js —
  // which package.json's exports and the hosts' build-graph tests address.
  // `index` is the legacy barrel with everything in it; the rest are the
  // entries described in docs/COMPONENT_LOADING.md. Code splitting keeps a
  // component that two entries share (the theme tokens, say) in one chunk
  // both import, and turns lazy.ts's import('./charts') into a reference to
  // dist/charts.js rather than a second copy of the charts.
  entry: {
    index: 'src/index.ts',
    minimal: 'src/entries/minimal.ts',
    lazy: 'src/entries/lazy.ts',
    theme: 'src/entries/theme.ts',
    scene3d: 'src/entries/scene3d.ts',
    charts: 'src/entries/charts.ts',
    editors: 'src/entries/editors.ts',
    smart: 'src/entries/smart.ts',
    media: 'src/entries/media.ts',
    animation: 'src/entries/animation.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: true,
  // Every three import stays external — the bare package and any addon path,
  // static or dynamic — so the host's bundler is the one that decides where
  // Three.js lands, and so a `three/addons/...` import added inside Scene3D
  // does not get inlined here and escape that decision.
  external: [
    'react',
    'react-dom',
    '@softn/core',
    /^three(\/.*)?$/,
    '@rc-component/qrcode',
    '@yudiel/react-qr-scanner',
  ],
  treeshake: true,
});
