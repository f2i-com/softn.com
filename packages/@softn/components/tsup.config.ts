import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: [
    'react', 'react-dom', '@softn/core', 'three',
    'three/addons/controls/OrbitControls.js',
    'three/addons/loaders/GLTFLoader.js',
    'three/addons/loaders/OBJLoader.js',
    'three/addons/loaders/FBXLoader.js',
    'three/addons/loaders/STLLoader.js',
  ],
  treeshake: true,
});
