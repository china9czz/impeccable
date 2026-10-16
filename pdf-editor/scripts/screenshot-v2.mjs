#!/usr/bin/env node
/**
 * Capture the full app window showing CJK annotations: opens the sample PDF
 * through the browser platform fallback, waits for the bundled CJK font,
 * paints a highlight, a Chinese text box and a Chinese sticky note, then
 * screenshots the window. Used for the v2 (CJK + undo) milestone.
 *
 *   node scripts/screenshot-v2.mjs [output.png]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'artifacts', 'screenshot-v2-cjk.png'));

function run(script) {
  const result = spawnSync('node', [script], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(path.join(root, 'dist', 'renderer', 'index.html'))) run('scripts/build.mjs');
if (!existsSync(path.join(root, 'sample', 'sample.pdf'))) run('scripts/make-sample.mjs');
mkdirSync(path.dirname(out), { recursive: true });

const { preview } = await import('vite');
const server = await preview({ preview: { port: 4175, strictPort: true } });

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

  await page.goto('http://localhost:4175/?sample=1', { waitUntil: 'load', timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector('canvas.page-canvas');
      return (
        canvas instanceof HTMLCanvasElement &&
        canvas.width > 200 &&
        document.querySelectorAll('.thumb').length >= 6 &&
        window.__vellumStore &&
        window.__vellumStore.getState().cjkFontStatus === 'ready'
      );
    },
    { timeout: 30_000 },
  );

  // Fit the first page fully, then paint: highlight over a headline, a
  // Chinese text box, and a Chinese sticky note near the top.
  await page.evaluate(() => window.__vellumStore.setFitMode('page'));
  await page.waitForTimeout(800);
  // Re-measure per step: fit-mode re-layout can shift the page box.
  const px = async (fx, fy) => {
    const wrap = await page.locator('.page-wrap').first().boundingBox();
    if (!wrap) throw new Error('no .page-wrap visible');
    return [wrap.x + wrap.width * fx, wrap.y + wrap.height * fy];
  };
  const tool = (title) => page.click(`button[title="${title}"]`);

  await tool('Highlight');
  await page.mouse.move(...(await px(0.1, 0.175)));
  await page.mouse.down();
  await page.mouse.move(...(await px(0.62, 0.19)), { steps: 8 });
  await page.mouse.up();

  await tool('Text');
  await page.mouse.click(...(await px(0.1, 0.42)));
  await page.waitForSelector('.inline-editor textarea', { timeout: 5000 });
  await page.evaluate(() => window.__vellumStore.setFontSize(20));
  await page.fill('.inline-editor textarea', '中文批注：支持保存与搜索');
  await page.click('.mini-btn.primary');

  await tool('Note');
  await page.mouse.click(...(await px(0.72, 0.3)));
  await page.waitForSelector('.inline-editor textarea', { timeout: 5000 });
  await page.fill('.inline-editor textarea', '便签：撤销/重做已支持 (Ctrl+Z)');
  await page.click('.mini-btn.primary');

  await page.waitForFunction(() => window.__vellumStore.annotationCount() >= 3, null, {
    timeout: 5000,
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: out, fullPage: false });
} catch (error) {
  failed = true;
  console.error('capture failed:', error);
} finally {
  await browser.close();
  await server.close();
}

if (failed || !existsSync(out)) {
  console.error('screenshot-v2 failed');
  process.exit(1);
}
console.log(`screenshot-v2 OK: ${out}`);
