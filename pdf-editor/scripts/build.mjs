#!/usr/bin/env node
/** Production build: esbuild for main + preload (CJS), Vite for the renderer. */
import { build } from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
};

await build({
  ...shared,
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main/index.js',
});

await build({
  ...shared,
  entryPoints: ['src/preload/index.ts'],
  outfile: 'dist/preload/index.js',
});

const { build: viteBuild } = await import('vite');
await viteBuild();

console.log('build complete: dist/main, dist/preload, dist/renderer');
