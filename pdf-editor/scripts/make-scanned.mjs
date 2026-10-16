#!/usr/bin/env node
/**
 * Build a one-page image-only PDF with Chinese + English ink (no text layer),
 * used by OCR E2E and the v3 screenshot harness.
 *
 *   node scripts/make-scanned.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'sample', 'scanned-ocr.pdf');
mkdirSync(path.dirname(out), { recursive: true });

const fontBytes = readFileSync(
  path.join(root, 'src/renderer/assets/fonts/NotoSansSC-Regular.subset.otf'),
);
const fontDataUrl = `data:font/otf;base64,${fontBytes.toString('base64')}`;

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 1100 } });
await page.setContent(
  `<!DOCTYPE html><html><head>
<style>
@font-face {
  font-family: 'NotoSC';
  src: url('${fontDataUrl}') format('opentype');
  font-weight: 400;
}
</style>
</head><body style="margin:0;background:#f4f1ea;">
<canvas id="c" width="800" height="1100"></canvas>
<script>
async function paint() {
  await document.fonts.load('48px NotoSC');
  await document.fonts.ready;
  const c = document.getElementById('c');
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f7f4ec';
  ctx.fillRect(0, 0, 800, 1100);
  ctx.fillStyle = '#1a1a1a';
  ctx.font = '48px NotoSC';
  ctx.fillText('扫描件识别测试', 80, 200);
  ctx.font = '36px NotoSC';
  ctx.fillText('你好，世界', 80, 280);
  ctx.font = '32px NotoSC';
  ctx.fillText('Hello OCR World', 80, 360);
  ctx.font = '28px NotoSC';
  ctx.fillText('Vellum PDF 电子签章演示', 80, 440);
  window.__painted = true;
}
paint().catch((e) => { window.__paintError = String(e); window.__painted = true; });
</script></body></html>`,
  { waitUntil: 'load' },
);
await page.waitForFunction(() => window.__painted === true, null, { timeout: 30_000 });
const paintError = await page.evaluate(() => window.__paintError ?? null);
if (paintError) console.warn('paint warning:', paintError);
await page.waitForTimeout(200);
const png = Buffer.from(await page.locator('#c').screenshot({ type: 'png' }));
await browser.close();

const doc = await PDFDocument.create();
const image = await doc.embedPng(png);
const pdfPage = doc.addPage([image.width * 0.75, image.height * 0.75]);
pdfPage.drawImage(image, {
  x: 0,
  y: 0,
  width: pdfPage.getWidth(),
  height: pdfPage.getHeight(),
});
const bytes = await doc.save();
writeFileSync(out, bytes);
console.log(`wrote ${out} (${bytes.length} bytes)`);
