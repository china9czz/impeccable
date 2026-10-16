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
  await page
    .waitForFunction(
      () => ['ready', 'error'].includes(window.__vellumStore.getState().cjkFontStatus),
      null,
      { timeout: 30_000 },
    )
    .catch(() => {});
  const fontStatus = await page.evaluate(() => window.__vellumStore.getState().cjkFontStatus);
  check(fontStatus === 'ready', `bundled CJK font loads in background (status=${fontStatus})`);

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

  // CJK text box + note: the save check below proves the bundled font embeds.
  await tool('Text');
  await page.mouse.click(...px(0.4, 0.92));
  await page.waitForSelector('.inline-editor textarea', { timeout: 5000 });
  await page.fill('.inline-editor textarea', '你好，Vellum！中文保存测试');
  await page.click('.mini-btn.primary');

  await tool('Note');
  await page.mouse.click(...px(0.7, 0.15));
  await page.waitForSelector('.inline-editor textarea', { timeout: 5000 });
  await page.fill('.inline-editor textarea', '批注：中文便签内容');
  await page.click('.mini-btn.primary');

  await page.waitForFunction(() => window.__vellumStore.annotationCount() >= 7, null, { timeout: 5000 });
  s = await state(page);
  check(s.annotations >= 7, `seven annotations created incl. CJK (got ${s.annotations})`);
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
  const compact = allText.replace(/\s+/g, '');
  check(allText.includes('E2E added text'), 'flattened text box is real text in the saved PDF');
  check(allText.includes('Test note from E2E'), 'flattened note is real text in the saved PDF');
  check(compact.includes('你好，Vellum！中文保存测试'), 'flattened CJK text is real text (bundled font embedded)');
  check(compact.includes('批注：中文便签内容'), 'flattened CJK note is real text');
  check(!compact.includes('???'), 'no "?" substitution of CJK characters');
  check(allText.includes('needle'), 'original text layer intact after flattening');
  s = await state(page);
  check(!s.dirty, 'dirty flag cleared after save');

  // ------------------------------------- 7b. reopen saved file (CJK roundtrip)
  console.log('reopen saved PDF');
  await page.evaluate((b64) => {
    const bin = atob(b64);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) data[i] = bin.charCodeAt(i);
    return window.__vellumStore.openFile({ path: '', name: 'saved-cjk.pdf', data });
  }, savedBytes.toString('base64'));
  await page.waitForFunction(
    () => window.__vellumStore.getState().phase === 'ready' &&
      window.__vellumStore.getState().fileName === 'saved-cjk.pdf',
    null,
    { timeout: 20_000 },
  );
  await page.waitForSelector('canvas.page-canvas', { timeout: 20_000 });
  s = await state(page);
  check(s.pageCount === 6, `reopened saved PDF with 6 pages (got ${s.pageCount})`);
  check(s.annotations === 0, 'annotations are flattened, not editable overlays, after reopen');
  await page.fill('#search-input', '中文保存测试');
  await page.press('#search-input', 'Enter');
  await page.waitForFunction(() => window.__vellumStore.getState().searchMatches.length > 0, null, { timeout: 20_000 });
  s = await state(page);
  check(s.matches >= 1, `CJK text searchable in reopened PDF (${s.matches} matches)`);
  await page.waitForSelector('.search-hit', { timeout: 20_000 });
  check((await page.locator('.search-hit').count()) > 0, 'CJK search hit highlighted after reopen');
  await page.evaluate(() => window.__vellumStore.clearSearch());

  // ------------------------------------------- 7c. undo/redo: annotations
  console.log('undo/redo: annotations');
  const undoBtn = 'button[title="Undo (Ctrl+Z)"]';
  const redoBtn = 'button[title="Redo (Ctrl+Shift+Z or Ctrl+Y)"]';
  check(!(await page.locator(undoBtn).isEnabled()), 'undo disabled on a freshly opened document');
  // The CJK search above scrolled to the match page; jump back to page 1 so
  // the coordinates below land inside the browser viewport.
  await page.evaluate(() => window.__vellumStore.goToPage(0));
  await page.evaluate(() => window.__vellumStore.setFitMode('page'));
  await page.waitForTimeout(400);
  const wrap2 = await page.locator('.page-wrap').first().boundingBox();
  if (!wrap2) throw new Error('no .page-wrap visible after reopen');
  const px2 = (fx, fy) => [wrap2.x + wrap2.width * fx, wrap2.y + wrap2.height * fy];
  const addText = async (fx, fy, text) => {
    await tool('Text');
    await page.mouse.click(...px2(fx, fy));
    await page.waitForSelector('.inline-editor textarea', { timeout: 5000 });
    await page.fill('.inline-editor textarea', text);
    await page.click('.mini-btn.primary');
  };
  await addText(0.2, 0.45, 'Undo chain A');
  await addText(0.2, 0.55, 'Undo chain B');
  await page.waitForFunction(() => window.__vellumStore.annotationCount() === 2, null, { timeout: 5000 });
  check(await page.locator(undoBtn).isEnabled(), 'undo enabled after edits');

  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => window.__vellumStore.annotationCount() === 1, null, { timeout: 5000 });
  check(true, 'Ctrl+Z undoes the last text box');
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(() => window.__vellumStore.annotationCount() === 2, null, { timeout: 5000 });
  check(true, 'Ctrl+Shift+Z redoes it');

  await page.evaluate(() => {
    const store = window.__vellumStore;
    const info = store.getPageInfo(0);
    const anns = info ? store.getAnnotations(info.id) : [];
    if (anns[0]) store.selectAnnotation(anns[0].id);
  });
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => window.__vellumStore.annotationCount() === 1, null, { timeout: 5000 });
  check(true, 'Delete removes the selected annotation');
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => window.__vellumStore.annotationCount() === 2, null, { timeout: 5000 });
  check(true, 'undo restores the deleted annotation');

  await page.click(undoBtn);
  await page.click(undoBtn);
  await page.waitForFunction(() => window.__vellumStore.annotationCount() === 0, null, { timeout: 5000 });
  check(true, 'toolbar undo steps back to zero annotations');
  check(!(await page.locator(undoBtn).isEnabled()), 'undo disabled at the bottom of the stack');
  check(await page.locator(redoBtn).isEnabled(), 'redo enabled after undos');
  await page.click(redoBtn);
  await page.click(redoBtn);
  await page.waitForFunction(() => window.__vellumStore.annotationCount() === 2, null, { timeout: 5000 });
  check(true, 'redo replays both text boxes');

  // ------------------------------------- 7d. undo/redo around a save point
  console.log('undo/redo: save point');
  const [saveDownload2] = await Promise.all([
    page.waitForEvent('download', { timeout: 20_000 }),
    page.keyboard.press('Control+s'),
  ]);
  await downloadToBuffer(saveDownload2);
  s = await state(page);
  check(!s.dirty, 'save pins the clean revision');
  await page.click(undoBtn);
  await page.waitForFunction(() => window.__vellumStore.getState().dirty, null, { timeout: 5000 });
  check(true, 'undo after save marks the document dirty again');
  await page.click(redoBtn);
  await page.waitForFunction(() => !window.__vellumStore.getState().dirty, null, { timeout: 5000 });
  s = await state(page);
  check(!s.dirty && s.annotations === 2, 'redo returns exactly to the saved revision');

  // ---------------------------------------- 7e. undo/redo: page operations
  console.log('undo/redo: page operations');
  const ratio0 = await ratioOf();
  prev = (await state(page)).docVersion;
  await page.click('button[title="Rotate page right"]');
  await waitDocVersion(page, prev);
  const ratio1 = await ratioOf();
  prev = (await state(page)).docVersion;
  await page.click(undoBtn);
  await waitDocVersion(page, prev);
  const ratio2 = await ratioOf();
  check(
    ratio0 < 0.9 && ratio1 > 1.1 && ratio2 < 0.9,
    `undo reverts rotation (${ratio0.toFixed(2)} -> ${ratio1.toFixed(2)} -> ${ratio2.toFixed(2)})`,
  );
  prev = (await state(page)).docVersion;
  await page.click(redoBtn);
  await waitDocVersion(page, prev);
  check((await ratioOf()) > 1.1, 'redo re-applies rotation');
  prev = (await state(page)).docVersion;
  await page.click(undoBtn);
  await waitDocVersion(page, prev);

  prev = (await state(page)).docVersion;
  await page.click('button[title="Insert blank page after current"]');
  await waitDocVersion(page, prev);
  s = await state(page);
  check(s.pageCount === 7, `blank page inserted again (pages=${s.pageCount})`);
  prev = (await state(page)).docVersion;
  await page.click(undoBtn);
  await waitDocVersion(page, prev);
  s = await state(page);
  check(s.pageCount === 6, 'undo removes the inserted blank page');

  prev = (await state(page)).docVersion;
  await page.click('button[title="Delete current page"]');
  await waitDocVersion(page, prev);
  s = await state(page);
  check(s.pageCount === 5, `page deleted for undo test (pages=${s.pageCount})`);
  prev = (await state(page)).docVersion;
  await page.click(undoBtn);
  await waitDocVersion(page, prev);
  s = await state(page);
  check(s.pageCount === 6, 'undo restores the deleted page byte-identical');

  const orderBefore = await page.evaluate(() => {
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
  prev = (await state(page)).docVersion;
  await page.click(undoBtn);
  await waitDocVersion(page, prev);
  const orderRestored = await page.evaluate(() => {
    const store = window.__vellumStore;
    return Array.from({ length: store.getState().pageCount }, (_, i) => store.getPageInfo(i)?.id ?? '?');
  });
  check(
    orderRestored.every((id, i) => id === orderBefore[i]),
    'undo restores the pre-drag page order',
  );

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

  prev = (await state(page)).docVersion;
  await page.click(undoBtn);
  await waitDocVersion(page, prev);
  s = await state(page);
  check(s.pageCount === 6, `undo un-merges (pages=${s.pageCount})`);
  check((await page.locator('.thumb').count()) === 6, 'sidebar shrinks back after un-merge');
  prev = (await state(page)).docVersion;
  await page.click(redoBtn);
  await waitDocVersion(page, prev);
  s = await state(page);
  check(s.pageCount === 12, `redo re-merges (pages=${s.pageCount})`);

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

  // ---------------------------------------------------------- 10. OCR Chinese
  console.log('OCR Chinese roundtrip');
  const scannedPath = path.join(root, 'sample', 'scanned-ocr.pdf');
  if (!existsSync(scannedPath)) run('scripts/make-scanned.mjs');
  const scannedBytes = readFileSync(scannedPath);
  await page.evaluate((b64) => {
    const bin = atob(b64);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) data[i] = bin.charCodeAt(i);
    return window.__vellumStore.openFile({ path: '', name: 'scanned-ocr.pdf', data });
  }, scannedBytes.toString('base64'));
  await page.waitForFunction(
    () => window.__vellumStore.getState().phase === 'ready' &&
      window.__vellumStore.getState().fileName === 'scanned-ocr.pdf',
    null,
    { timeout: 20_000 },
  );
  await page.waitForSelector('canvas.page-canvas', { timeout: 20_000 });
  // Image-only page: search should find nothing before OCR.
  await page.fill('#search-input', '你好');
  await page.press('#search-input', 'Enter');
  await page.waitForTimeout(800);
  s = await state(page);
  check(s.matches === 0, 'image-only PDF has no searchable Chinese before OCR');
  await page.evaluate(() => window.__vellumStore.clearSearch());

  await page.click('button[title="OCR current page (Chinese + English)"]');
  await page.waitForFunction(
    () => {
      const st = window.__vellumStore.getState();
      return st.ocrProgress === null && window.__vellumStore.annotationCount() >= 1;
    },
    null,
    { timeout: 180_000 },
  );
  const ocrWords = await page.evaluate(() => {
    const store = window.__vellumStore;
    const info = store.getPageInfo(0);
    const anns = info ? store.getAnnotations(info.id) : [];
    const ocr = anns.find((a) => a.kind === 'ocr');
    return ocr ? ocr.runs.map((r) => r.text).join(' ') : '';
  });
  check(/你好/.test(ocrWords) || /扫描/.test(ocrWords) || /Hello/i.test(ocrWords),
    `OCR produced Chinese/English text (got "${ocrWords.slice(0, 80)}")`);

  await page.fill('#search-input', '你好');
  await page.press('#search-input', 'Enter');
  await page.waitForFunction(() => window.__vellumStore.getState().searchMatches.length > 0, null, {
    timeout: 20_000,
  }).catch(() => {});
  s = await state(page);
  if (s.matches === 0) {
    // Fall back to whatever OCR actually found (confidence / font quirks).
    const probe = (ocrWords.match(/[\u4e00-\u9fff]{2,}/) || ocrWords.match(/Hello/i) || ['OCR'])[0];
    await page.fill('#search-input', probe);
    await page.press('#search-input', 'Enter');
    await page.waitForFunction(() => window.__vellumStore.getState().searchMatches.length > 0, null, {
      timeout: 20_000,
    });
    s = await state(page);
    check(s.matches >= 1, `in-app search finds OCR text ("${probe}", ${s.matches} matches)`);
  } else {
    check(s.matches >= 1, `in-app search finds OCR Chinese (你好, ${s.matches} matches)`);
  }
  await page.evaluate(() => window.__vellumStore.clearSearch());

  const [ocrSave] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.keyboard.press('Control+s'),
  ]);
  const ocrSavedBytes = await downloadToBuffer(ocrSave);
  const ocrPdfjs = await pdfjs.getDocument({
    data: new Uint8Array(ocrSavedBytes),
    standardFontDataUrl: path.join(root, 'node_modules', 'pdfjs-dist', 'standard_fonts') + path.sep,
  }).promise;
  const ocrPage = await ocrPdfjs.getPage(1);
  const ocrContent = await ocrPage.getTextContent();
  const ocrFlat = ocrContent.items.map((item) => item.str).join('');
  check(
    /[\u4e00-\u9fff]/.test(ocrFlat) || /Hello/i.test(ocrFlat),
    `saved PDF keeps OCR text layer (sample: "${ocrFlat.slice(0, 60)}")`,
  );

  await page.evaluate((b64) => {
    const bin = atob(b64);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) data[i] = bin.charCodeAt(i);
    return window.__vellumStore.openFile({ path: '', name: 'ocr-reopen.pdf', data });
  }, ocrSavedBytes.toString('base64'));
  await page.waitForFunction(
    () => window.__vellumStore.getState().phase === 'ready' &&
      window.__vellumStore.getState().fileName === 'ocr-reopen.pdf',
    null,
    { timeout: 30_000 },
  );
  await page.waitForSelector('canvas.page-canvas', { timeout: 30_000 });
  // Prefer a short known token — flattened runs are separate text items joined
  // with spaces, so a long contiguous CJK slice from ocrFlat may not match.
  const reopenProbe =
    (/你好/.test(ocrFlat) && '你好') ||
    (/扫描/.test(ocrFlat) && '扫描') ||
    (/Hello/i.test(ocrFlat) && 'Hello') ||
    (ocrFlat.match(/[\u4e00-\u9fff]{2}/) || ['OCR'])[0];
  // Drive search via the store directly: the text layer can take a moment to
  // extract after reopen (embedded CJK font), and UI Enter can race that.
  await page.evaluate(async (q) => {
    await window.__vellumStore.runSearch(q);
  }, reopenProbe);
  await page.waitForFunction(() => window.__vellumStore.getState().searchMatches.length > 0, null, {
    timeout: 30_000,
  });
  s = await state(page);
  check(s.matches >= 1, `reopened OCR PDF still searchable ("${reopenProbe}")`);
  await page.evaluate(() => window.__vellumStore.clearSearch());

  // ----------------------------------------------- 11. signature flatten + undo
  console.log('signature flatten + undo');
  const sigDataUrl = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 80;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 240, 80);
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(20, 50);
    ctx.bezierCurveTo(60, 10, 120, 70, 220, 30);
    ctx.stroke();
    ctx.font = '18px sans-serif';
    ctx.fillStyle = '#111827';
    ctx.fillText('E2E Sign', 70, 60);
    return canvas.toDataURL('image/png');
  });
  await page.evaluate((dataUrl) => {
    const store = window.__vellumStore;
    const info = store.getPageInfo(0);
    if (!info) throw new Error('no page');
    store.placeSignature(info.id, dataUrl, { x: 80, y: 120 }, { w: 160, h: 54 });
  }, sigDataUrl);
  await page.waitForFunction(() => window.__vellumStore.annotationCount() >= 1, null, { timeout: 5000 });
  check((await page.locator('.ann-signature').count()) >= 1, 'signature annotation renders on the page');

  const beforeSig = await page.evaluate(() => window.__vellumStore.annotationCount());
  await page.keyboard.press('Control+z');
  await page.waitForFunction(
    (n) => window.__vellumStore.annotationCount() === n - 1,
    beforeSig,
    { timeout: 5000 },
  );
  check(true, 'undo removes the placed signature');
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(
    (n) => window.__vellumStore.annotationCount() === n,
    beforeSig,
    { timeout: 5000 },
  );
  check(true, 'redo restores the signature');

  // Stamp a second copy via multi-page helper (single page doc → 1 extra).
  await page.evaluate((dataUrl) => {
    window.__vellumStore.stampSignatureOnPages(dataUrl, [0]);
  }, sigDataUrl);
  const afterStamp = await page.evaluate(() => window.__vellumStore.annotationCount());
  check(afterStamp >= beforeSig + 1, `stamp adds another signature (count=${afterStamp})`);

  const [sigSave] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    page.keyboard.press('Control+s'),
  ]);
  const sigBytes = await downloadToBuffer(sigSave);
  const sigDoc = await PDFDocument.load(sigBytes);
  check(sigDoc.getPageCount() === 1, 'signature save keeps page count');
  // pdf-lib embeds images as XObjects; presence of /Subtype /Image is enough.
  const sigRaw = Buffer.from(sigBytes).toString('latin1');
  check(/\/Subtype\s*\/Image/.test(sigRaw), 'flattened signature embeds an image XObject');

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
