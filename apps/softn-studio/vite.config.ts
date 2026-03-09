import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 1423,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
