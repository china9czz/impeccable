#!/usr/bin/env node
/**
 * Headless verification: build the app, generate the sample PDF, launch
 * Electron (under xvfb-run when no display is available), let it open the
 * sample automatically, and capture the full window to a PNG.
 *
 *   node scripts/screenshot.mjs [output.png]
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'artifacts', 'screenshot.png'));
const sample = path.join(root, 'sample', 'sample.pdf');

if (!existsSync(path.join(root, 'dist', 'main', 'index.js'))) {
  const build = spawnSync('node', ['scripts/build.mjs'], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status ?? 1);
}
if (!existsSync(sample)) {
  const gen = spawnSync('node', ['scripts/make-sample.mjs'], { cwd: root, stdio: 'inherit' });
  if (gen.status !== 0) process.exit(gen.status ?? 1);
}

mkdirSync(path.dirname(out), { recursive: true });

const env = {
  ...process.env,
  PDF_EDITOR_SCREENSHOT: out,
  PDF_EDITOR_AUTOOPEN: sample,
};

const hasDisplay = Boolean(process.env.DISPLAY);
const hasXvfb = spawnSync('which', ['xvfb-run'], { stdio: 'ignore' }).status === 0;
const cmd = hasDisplay ? electronPath : hasXvfb ? 'xvfb-run' : electronPath;
const args = hasDisplay
  ? ['.']
  : hasXvfb
    ? ['-a', '-s', '-screen 0 1600x1000x24', electronPath, '.']
    : ['.'];

if (!hasDisplay && !hasXvfb) {
  console.error('no DISPLAY and no xvfb-run; Electron will likely fail to start');
}

const child = spawn(cmd, args, { cwd: root, env, stdio: 'inherit' });
const timeout = setTimeout(() => {
  console.error('screenshot timed out after 90s');
  child.kill('SIGKILL');
  process.exit(1);
}, 90_000);

child.on('exit', (code) => {
  clearTimeout(timeout);
  if (code === 0 && existsSync(out)) {
    console.log(`screenshot OK: ${out}`);
    process.exit(0);
  }
  console.error(`screenshot failed (exit ${code})`);
  process.exit(code ?? 1);
});
