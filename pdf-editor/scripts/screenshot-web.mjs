#!/usr/bin/env node
/**
 * Renderer-preview verification harness: serves the built app with
 * `vite preview` and drives it with headless Chrome (system install) via
 * playwright-core. The renderer auto-opens sample/sample.pdf through the
 * browser platform fallback (?sample=1), then the full window is captured.
 *
 * This is the sandbox-friendly counterpart to scripts/screenshot.mjs, used
 * where Electron's Chromium cannot run (e.g. gVisor-blocked shared memory).
 *
 *   node scripts/screenshot-web.mjs [output.png]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'artifacts', 'screenshot-web.png'));

function run(script) {
  const result = spawnSync('node', [script], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(path.join(root, 'dist', 'renderer', 'index.html'))) run('scripts/build.mjs');
if (!existsSync(path.join(root, 'sample', 'sample.pdf'))) run('scripts/make-sample.mjs');
mkdirSync(path.dirname(out), { recursive: true });

const { preview } = await import('vite');
const server = await preview({ preview: { port: 4173, strictPort: true } });

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => console.error('[pageerror]', error.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('[console]', msg.text());
  });

  await page.goto('http://localhost:4173/?sample=1', { waitUntil: 'load', timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector('canvas.page-canvas');
      return (
        canvas instanceof HTMLCanvasElement &&
        canvas.width > 200 &&
        document.querySelectorAll('.thumb').length >= 6 &&
        document.querySelector('.thumb canvas') instanceof HTMLCanvasElement
      );
    },
    { timeout: 30_000 },
  );
  // Give remaining thumbnails and above-the-fold pages time to paint.
  await page.waitForTimeout(2500);
  await page.screenshot({ path: out, fullPage: false });
} catch (error) {
  failed = true;
  console.error('capture failed:', error);
} finally {
  await browser.close();
  await server.close();
}

if (failed || !existsSync(out)) {
  console.error('screenshot-web failed');
  process.exit(1);
}
console.log(`screenshot-web OK: ${out}`);
