#!/usr/bin/env node
/**
 * Capture OCR result + placed signature for the v3 milestone.
 *
 *   node scripts/screenshot-v3.mjs [output.png]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(
  process.argv[2] ?? path.join(root, 'artifacts', 'screenshot-v3-ocr-sign.png'),
);

function run(script) {
  const result = spawnSync('node', [script], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(path.join(root, 'dist', 'renderer', 'index.html'))) run('scripts/build.mjs');
if (!existsSync(path.join(root, 'sample', 'scanned-ocr.pdf'))) run('scripts/make-scanned.mjs');
mkdirSync(path.dirname(out), { recursive: true });

const scannedBytes = readFileSync(path.join(root, 'sample', 'scanned-ocr.pdf'));

const { preview } = await import('vite');
const server = await preview({ preview: { port: 4176, strictPort: true } });

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

  await page.goto('http://localhost:4176/', { waitUntil: 'load', timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.__vellumStore), null, { timeout: 15_000 });

  await page.evaluate((b64) => {
    const bin = atob(b64);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) data[i] = bin.charCodeAt(i);
    return window.__vellumStore.openFile({ path: '', name: 'scanned-ocr.pdf', data });
  }, scannedBytes.toString('base64'));

  await page.waitForFunction(
    () => {
      const canvas = document.querySelector('canvas.page-canvas');
      return (
        canvas instanceof HTMLCanvasElement &&
        canvas.width > 200 &&
        window.__vellumStore.getState().phase === 'ready'
      );
    },
    { timeout: 30_000 },
  );

  await page.evaluate(() => window.__vellumStore.setFitMode('page'));
  await page.waitForTimeout(500);

  await page.click('button[title="OCR current page (Chinese + English)"]');
  await page.waitForFunction(
    () => {
      const st = window.__vellumStore.getState();
      return st.ocrProgress === null && window.__vellumStore.annotationCount() >= 1;
    },
    null,
    { timeout: 180_000 },
  );

  // Place a drawn-style signature in the lower area.
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 280;
    canvas.height = 90;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 280, 90);
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(16, 55);
    ctx.bezierCurveTo(50, 8, 110, 88, 170, 28);
    ctx.bezierCurveTo(200, 8, 230, 60, 260, 40);
    ctx.stroke();
    ctx.font = '20px "Segoe UI", sans-serif';
    ctx.fillStyle = '#1a1a1a';
    ctx.fillText('Alex Signer', 90, 78);
    const dataUrl = canvas.toDataURL('image/png');
    const store = window.__vellumStore;
    const info = store.getPageInfo(0);
    store.placeSignature(info.id, dataUrl, { x: 360, y: 160 }, { w: 180, h: 58 });
  });

  await page.waitForFunction(() => window.__vellumStore.annotationCount() >= 2, null, {
    timeout: 5000,
  });

  // Highlight an OCR hit so the screenshot shows the searchable layer.
  const probe = await page.evaluate(() => {
    const store = window.__vellumStore;
    const info = store.getPageInfo(0);
    const anns = info ? store.getAnnotations(info.id) : [];
    const ocr = anns.find((a) => a.kind === 'ocr');
    const joined = ocr ? ocr.runs.map((r) => r.text).join('') : '';
    return (joined.match(/[\u4e00-\u9fff]{2,}/) || joined.match(/Hello/i) || ['OCR'])[0];
  });
  await page.fill('#search-input', probe);
  await page.press('#search-input', 'Enter');
  await page.waitForTimeout(600);

  await page.screenshot({ path: out, fullPage: false });
} catch (error) {
  failed = true;
  console.error('capture failed:', error);
} finally {
  await browser.close();
  await server.close();
}

if (failed || !existsSync(out) || statSync(out).size < 1000) {
  console.error('screenshot-v3 failed');
  process.exit(1);
}
console.log(`screenshot-v3 OK: ${out} (${statSync(out).size} bytes)`);
