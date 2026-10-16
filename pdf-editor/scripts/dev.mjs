#!/usr/bin/env node
/**
 * Dev runner: watch main + preload with esbuild, serve the renderer with the
 * Vite dev server (in-process), then launch Electron pointed at the dev URL.
 * Quitting the Electron window stops everything.
 */
import { context } from 'esbuild';
import electronPath from 'electron';
import { spawn } from 'node:child_process';

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'silent',
};

const mainCtx = await context({
  ...shared,
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main/index.js',
});
const preloadCtx = await context({
  ...shared,
  entryPoints: ['src/preload/index.ts'],
  outfile: 'dist/preload/index.js',
});
await Promise.all([mainCtx.watch(), preloadCtx.watch()]);

const { createServer } = await import('vite');
const server = await createServer();
await server.listen();

const child = spawn(electronPath, ['.'], {
  env: { ...process.env, VITE_DEV_SERVER_URL: 'http://localhost:5173' },
  stdio: 'inherit',
});

let stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  await server.close();
  await Promise.all([mainCtx.dispose(), preloadCtx.dispose()]);
  process.exit(code);
}

child.on('exit', (code) => void shutdown(code ?? 0));
process.on('SIGINT', () => {
  child.kill('SIGINT');
  void shutdown(0);
});
process.on('SIGTERM', () => {
  child.kill('SIGTERM');
  void shutdown(0);
});

console.log('dev: Vite on http://localhost:5173, Electron starting (restart after editing main/preload)');
