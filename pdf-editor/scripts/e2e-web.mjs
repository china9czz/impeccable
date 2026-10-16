#!/usr/bin/env node
/**
 * End-to-end functional verification against the built renderer, driven with
 * headless Chrome (system install) through the real UI: search, annotation
 * tools, page operations, reorder DnD, merge, split, and save-with-flatten.
 * Downloads are captured and re-parsed with pdf-lib / pdf.js in Node to prove
 * the flattened output.
 *
 *   node scripts/e2e-web.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sample = path.join(root, 'sample', 'sample.pdf');

function run(script) {
  const result = spawnSync('node', [script], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (!existsSync(path.join(root, 'dist', 'renderer', 'index.html'))) run('scripts/build.mjs');
if (!existsSync(sample)) run('scripts/make-sample.mjs');

const failures = [];
let checkCount = 0;
function check(condition, label) {
  checkCount += 1;
  if (condition) {
    console.log(`  ok  ${label}`);
  } else {
    failures.push(label);
    console.log(`FAIL  ${label}`);
  }
}

const { preview } = await import('vite');
const server = await preview({ preview: { port: 4174, strictPort: true } });

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const state = (page) =>
  page.evaluate(() => {
    const s = window.__vellumStore.getState();
    return {
      pageCount: s.pageCount,
      currentPage: s.currentPage,
      dirty: s.dirty,
      docVersion: s.docVersion,
      matches: s.searchMatches.length,
      active: s.searchActive,
      annotations: window.__vellumStore.annotationCount(),
    };
  });

async function waitDocVersion(page, prev) {
  await page.waitForFunction(
    (v) => window.__vellumStore && window.__vellumStore.getState().docVersion !== v,
    prev,
    { timeout: 20_000 },
  );
}

async function downloadToBuffer(download) {
  const filePath = await download.path();
  return readFileSync(filePath);
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => console.error('[pageerror]', error.message));

  // ------------------------------------------------------------- 1. open
  console.log('open + render');
  await page.goto('http://localhost:4174/?sample=1', { waitUntil: 'load', timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector('canvas.page-canvas');
      return canvas instanceof HTMLCanvasElement && canvas.width > 200;
    },
    { timeout: 30_000 },
  );
  let s = await state(page);
  check(s.pageCount === 6, `opens sample with 6 pages (got ${s.pageCount})`);
  check((await page.locator('.thumb').count()) === 6, 'sidebar shows 6 thumbnails');

  // ------------------------------------------------------------ 2. search
  console.log('search');
  await page.fill('#search-input', 'needle');
  await page.press('#search-input', 'Enter');
  await page.waitForFunction(() => window.__vellumStore.getState().searchMatches.length > 0, null, { timeout: 20_000 });
  await page.waitForSelector('.search-hit', { timeout: 20_000 });
  s = await state(page);
  check(s.matches >= 5, `finds needle matches across pages (got ${s.matches})`);
  check((await page.locator('.search-hit').count()) > 0, 'renders highlight rectangles for matches');
  await page.press('#search-input', 'Enter');
  s = await state(page);
  check(s.active === 1, `Enter advances to next match (active=${s.active})`);
  await page.evaluate(() => window.__vellumStore.clearSearch());

  // -------------------------------------------------------- 3. annotations
  console.log('annotations');
  // Fit the whole page in view so every fractional position below is inside
  // the browser viewport (raw mouse events cannot land outside it).
  await page.evaluate(() => window.__vellumStore.setFitMode('page'));
  await page.waitForTimeout(400);
  const wrap = await page.locator('.page-wrap').first().boundingBox();
  if (!wrap) throw new Error('no .page-wrap visible');
  const px = (fx, fy) => [wrap.x + wrap.width * fx, wrap.y + wrap.height * fy];

  const tool = async (title) => page.click(`button[title="${title}"]`);

  await tool('Highlight');
  await page.mouse.move(...px(0.15, 0.32));
  await page.mouse.down();
  await page.mouse.move(...px(0.7, 0.345), { steps: 8 });
  await page.mouse.up();

  await tool('Pen');
  await page.mouse.move(...px(0.2, 0.55));
  await page.mouse.down();
  for (let i = 1; i <= 10; i += 1) {
    await page.mouse.move(...px(0.2 + i * 0.04, 0.55 + Math.sin(i) * 0.02), { steps: 2 });
  }
  await page.mouse.up();

  await tool('Rectangle');
  await page.mouse.move(...px(0.55, 0.6));
  await page.mouse.down();
  await page.mouse.move(...px(0.85, 0.7), { steps: 6 });
  await page.mouse.up();

  await tool('Note');
  await page.mouse.click(...px(0.3, 0.78));
  await page.waitForSelector('.inline-editor textarea', { timeout: 5000 });
  await page.fill('.inline-editor textarea', 'Test note from E2E');
  await page.click('.mini-btn.primary');

  await tool('Text');
  await page.mouse.click(...px(0.45, 0.85));
  await page.waitForSelector('.inline-editor textarea', { timeout: 5000 });
  await page.fill('.inline-editor textarea', 'E2E added text');
  await page.click('.mini-btn.primary');

  await page.waitForFunction(() => window.__vellumStore.annotationCount() >= 5, null, { timeout: 5000 });
  s = await state(page);
  check(s.annotations >= 5, `five annotations created (got ${s.annotations})`);
  check((await page.locator('.ann-shape').count()) >= 5, 'annotations render on the overlay layer');
  check(s.dirty, 'document marked dirty after annotating');

  // ------------------------------------------------------------ 4. rotate
  console.log('page operations');
  const ratioOf = async () => {
    const box = await page.locator('.page-wrap').first().boundingBox();
    return box ? box.width / box.height : 0;
  };
  const ratioBefore = await ratioOf();
  let prev = s.docVersion;
  await page.click('button[title="Rotate page right"]');
  await waitDocVersion(page, prev);
  const ratioAfter = await ratioOf();
  check(ratioBefore < 0.9 && ratioAfter > 1.1, `rotate swaps page aspect (before ${ratioBefore.toFixed(2)}, after ${ratioAfter.toFixed(2)})`);
  // rotate back so save output stays portrait for text checks
  prev = (await state(page)).docVersion;
  await page.click('button[title="Rotate page left"]');
  await waitDocVersion(page, prev);

  // --------------------------------------------------- 5. insert + delete
  s = await state(page);
  prev = s.docVersion;
  await page.click('button[title="Insert blank page after current"]');
  await waitDocVersion(page, prev);
  s = await state(page);
  check(s.pageCount === 7, `blank page inserted (pages=${s.pageCount})`);

  prev = s.docVersion;
  await page.click('button[title="Delete current page"]');
  await waitDocVersion(page, prev);
  s = await state(page);
  check(s.pageCount === 6, `blank page deleted again (pages=${s.pageCount})`);

  // ------------------------------------------------------------ 6. reorder
  const idsBefore = await page.evaluate(() => {
    const store = window.__vellumStore;
    return Array.from({ length: store.getState().pageCount }, (_, i) => store.getPageInfo(i)?.id ?? '?');
  });
  prev = (await state(page)).docVersion;
  await page.evaluate(() => {
    const dt = new DataTransfer();
    const thumbs = [...document.querySelectorAll('.thumb')];
    const src = thumbs[0];
    const dst = thumbs[1];
    const rect = dst.getBoundingClientRect();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientY: rect.bottom - 2, cancelable: true }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientY: rect.bottom - 2 }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  });
  await waitDocVersion(page, prev);
  const idsAfter = await page.evaluate(() => {
    const store = window.__vellumStore;
    return Array.from({ length: store.getState().pageCount }, (_, i) => store.getPageInfo(i)?.id ?? '?');
  });
  check(
    idsAfter[1] === idsBefore[0] && idsAfter[0] === idsBefore[1],
    'drag in sidebar reorders pages (page 1 -> position 2)',
  );
  const annsOnMovedPage = await page.evaluate(() => {
    const store = window.__vellumStore;
    const info = store.getPageInfo(1);
    return info ? store.getAnnotations(info.id).length : -1;
  });
  check(annsOnMovedPage >= 5, `annotations follow their page after reorder (${annsOnMovedPage} on moved page)`);

  // --------------------------------------------------------------- 7. save
  console.log('save with flatten');
  const [saveDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 20_000 }),
    page.keyboard.press('Control+s'),
  ]);
  const savedBytes = await downloadToBuffer(saveDownload);
  check(savedBytes.subarray(0, 5).toString() === '%PDF-', 'saved file is a valid PDF');
  const savedDoc = await PDFDocument.load(savedBytes);
  check(savedDoc.getPageCount() === 6, `saved PDF keeps 6 pages (got ${savedDoc.getPageCount()})`);

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const textDoc = await pdfjs.getDocument({
    data: new Uint8Array(savedBytes),
    standardFontDataUrl: path.join(root, 'node_modules', 'pdfjs-dist', 'standard_fonts') + path.sep,
  }).promise;
  let allText = '';
  for (let i = 1; i <= textDoc.numPages; i += 1) {
    const pdfPage = await textDoc.getPage(i);
    const content = await pdfPage.getTextContent();
    allText += content.items.map((item) => item.str).join(' ') + '\n';
  }
  check(allText.includes('E2E added text'), 'flattened text box is real text in the saved PDF');
  check(allText.includes('Test note from E2E'), 'flattened note is real text in the saved PDF');
  check(allText.includes('needle'), 'original text layer intact after flattening');
  s = await state(page);
  check(!s.dirty, 'dirty flag cleared after save');

  // --------------------------------------------------------------- 8. merge
  console.log('merge');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10_000 }),
    page.click('button:has-text("Merge")'),
  ]);
  prev = (await state(page)).docVersion;
  await chooser.setFiles(sample);
  await waitDocVersion(page, prev);
  s = await state(page);
  check(s.pageCount === 12, `merge appends 6 pages (pages=${s.pageCount})`);
  check((await page.locator('.thumb').count()) === 12, 'sidebar reflects merged page count');

  // --------------------------------------------------------------- 9. split
  console.log('split');
  await page.click('button:has-text("Split")');
  await page.waitForSelector('.modal input', { timeout: 5000 });
  await page.fill('.modal input', '1-3');
  const [splitDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 20_000 }),
    page.click('.modal .btn.primary'),
  ]);
  const splitBytes = await downloadToBuffer(splitDownload);
  const splitDoc = await PDFDocument.load(splitBytes);
  check(splitDoc.getPageCount() === 3, `split exports exactly 3 pages (got ${splitDoc.getPageCount()})`);
  s = await state(page);
  check(s.pageCount === 12, 'open document unchanged after split export');

  await page.close();
} catch (error) {
  failures.push(`harness error: ${error instanceof Error ? error.message : String(error)}`);
  console.error(error);
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${checkCount - failures.length}/${checkCount} checks passed`);
if (failures.length > 0) {
  console.error('FAILURES:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('E2E OK');
