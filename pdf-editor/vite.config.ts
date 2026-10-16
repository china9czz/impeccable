import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    // tesseract.js worker + wasm + CJK font push the main chunk up.
    chunkSizeWarningLimit: 4000,
  },
  optimizeDeps: {
    exclude: ['tesseract.js'],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  worker: {
    format: 'es',
  },
});
