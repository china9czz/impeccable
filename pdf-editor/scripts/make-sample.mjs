#!/usr/bin/env node
/**
 * Generates sample/sample.pdf: a 6-page document with extractable text for
 * search testing, drawn vector elements, and a mostly-empty notes page.
 * Also copies it to public/ so the browser preview can fetch it.
 */
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 64;

const INK = rgb(0.13, 0.15, 0.2);
const GRAY = rgb(0.42, 0.46, 0.52);
const ACCENT = rgb(0.31, 0.55, 1);
const RULE = rgb(0.82, 0.84, 0.88);

function wrap(text, font, size, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawParagraph(page, font, text, x, startY, size, leading, color) {
  let y = startY;
  for (const line of wrap(text, font, size, PAGE_W - 2 * MARGIN)) {
    page.drawText(line, { x, y, size, font, color });
    y -= leading;
  }
  return y;
}

function drawFooter(page, font, n, total) {
  page.drawLine({
    start: { x: MARGIN, y: 54 },
    end: { x: PAGE_W - MARGIN, y: 54 },
    thickness: 0.5,
    color: RULE,
  });
  page.drawText(`Vellum PDF sample document  ·  Page ${n} of ${total}`, {
    x: MARGIN,
    y: 40,
    size: 8.5,
    font,
    color: GRAY,
  });
}

const doc = await PDFDocument.create();
doc.setTitle('Vellum PDF Editor: sample document');
doc.setAuthor('Vellum PDF');
const helvetica = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

const TOTAL = 6;

// ---------------------------------------------------------------- page 1
{
  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawRectangle({ x: 0, y: PAGE_H - 130, width: PAGE_W, height: 130, color: rgb(0.12, 0.14, 0.18) });
  page.drawText('Vellum PDF Editor', { x: MARGIN, y: PAGE_H - 74, size: 30, font: bold, color: rgb(1, 1, 1) });
  page.drawText('Sample document for viewing, search, annotation and page operations', {
    x: MARGIN,
    y: PAGE_H - 98,
    size: 11.5,
    font: helvetica,
    color: rgb(0.75, 0.8, 0.9),
  });
  let y = PAGE_H - 180;
  y = drawParagraph(
    page, helvetica,
    'This document was generated with pdf-lib. Every paragraph on these pages is real, extractable text, ' +
      'which makes it useful for exercising the in-document search of a PDF editor. Try searching for the ' +
      'word needle: it appears several times across this file, on purpose, so that next and previous match ' +
      'navigation has something to find.',
    MARGIN, y, 11, 16, INK,
  );
  y -= 18;
  y = drawParagraph(
    page, helvetica,
    'The editor under test supports continuous scrolling, zoom, page thumbnails, rotation, deletion, ' +
      'reordering, blank page insertion, merging, splitting, annotations and free text. This page gives ' +
      'its highlight and pen tools something realistic to work on.',
    MARGIN, y, 11, 16, INK,
  );
  y -= 26;
  page.drawRectangle({ x: MARGIN, y: y - 96, width: PAGE_W - 2 * MARGIN, height: 96, borderColor: ACCENT, borderWidth: 1.2, borderRadius: 6 });
  page.drawText('Quick facts', { x: MARGIN + 16, y: y - 26, size: 12, font: bold, color: ACCENT });
  page.drawText('Format: PDF 1.7   ·   Pages: 6   ·   Fonts: Helvetica, Helvetica-Bold', {
    x: MARGIN + 16, y: y - 46, size: 10, font: helvetica, color: INK,
  });
  page.drawText('Search needle count in this file: 6   ·   Generated: deterministically by script', {
    x: MARGIN + 16, y: y - 62, size: 10, font: helvetica, color: INK,
  });
  page.drawText('Nothing here is confidential. Mark it up freely.', {
    x: MARGIN + 16, y: y - 78, size: 10, font: helvetica, color: GRAY,
  });
  drawFooter(page, helvetica, 1, TOTAL);
}

// --------------------------------------------------------------- page 2
{
  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawText('1  Viewing and navigation', { x: MARGIN, y: PAGE_H - 84, size: 18, font: bold, color: INK });
  page.drawLine({ start: { x: MARGIN, y: PAGE_H - 96 }, end: { x: PAGE_W - MARGIN, y: PAGE_H - 96 }, thickness: 0.7, color: RULE });
  let y = PAGE_H - 128;
  y = drawParagraph(
    page, helvetica,
    'A capable reader view is the foundation of any PDF editor. Pages should render sharply at every zoom ' +
      'level, scroll continuously without pagination friction, and keep thumbnails in sync as the document ' +
      'changes. The left sidebar mirrors the page order at all times and doubles as the drag target for ' +
      'reordering.',
    MARGIN, y, 11, 16, INK,
  );
  y -= 16;
  y = drawParagraph(
    page, helvetica,
    'Zoom controls live in the top toolbar alongside fit width and fit page. Page navigation accepts direct ' +
      'numeric input, and the current page indicator follows the scroll position rather than the other way ' +
      'around. A search needle hides in section 2.1 below; the highlight overlay should find it without ' +
      'disturbing the underlying text.',
    MARGIN, y, 11, 16, INK,
  );
  y -= 24;
  page.drawText('2.1  Text extraction', { x: MARGIN, y, size: 13, font: bold, color: INK });
  y -= 20;
  y = drawParagraph(
    page, helvetica,
    'Search depends on a faithful text layer. Each line you are reading now is positioned with drawText, ' +
      'so pdf.js can recover every glyph. When a needle appears mid-sentence, like this needle right here, ' +
      'the match rectangle must cover the word and nothing else.',
    MARGIN, y, 11, 16, INK,
  );
  drawFooter(page, helvetica, 2, TOTAL);
}

// --------------------------------------------------------------- page 3
{
  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawText('2  Page operations', { x: MARGIN, y: PAGE_H - 84, size: 18, font: bold, color: INK });
  page.drawLine({ start: { x: MARGIN, y: PAGE_H - 96 }, end: { x: PAGE_W - MARGIN, y: PAGE_H - 96 }, thickness: 0.7, color: RULE });
  let y = PAGE_H - 128;
  y = drawParagraph(
    page, helvetica,
    'Rotate, delete, reorder and insert: the four operations every Acrobat-class tool gets right before ' +
      'anything else. Rotation applies in ninety degree steps and the view follows immediately. Deleting ' +
      'the final page is refused. Reordering uses the thumbnail sidebar and keeps every annotation glued ' +
      'to its original page.',
    MARGIN, y, 11, 16, INK,
  );
  y -= 16;
  y = drawParagraph(
    page, helvetica,
    'This page is a good rotation candidate: turn it sideways and the toolbar, thumbnails and annotation ' +
      'overlay should all agree about where the top of the page is. A needle sits on this page too, so ' +
      'search highlighting can be checked against rotated text as well.',
    MARGIN, y, 11, 16, INK,
  );
  y -= 24;
  page.drawRectangle({ x: MARGIN, y: y - 60, width: 220, height: 60, color: rgb(0.94, 0.96, 1), borderColor: RULE, borderWidth: 0.8 });
  page.drawText('Blank pages inherit the size of the current page.', { x: MARGIN + 12, y: y - 34, size: 9.5, font: helvetica, color: GRAY });
  drawFooter(page, helvetica, 3, TOTAL);
}

// --------------------------------------------------------------- page 4
{
  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawText('3  Merge and split', { x: MARGIN, y: PAGE_H - 84, size: 18, font: bold, color: INK });
  page.drawLine({ start: { x: MARGIN, y: PAGE_H - 96 }, end: { x: PAGE_W - MARGIN, y: PAGE_H - 96 }, thickness: 0.7, color: RULE });
  let y = PAGE_H - 128;
  y = drawParagraph(
    page, helvetica,
    'Merging appends every page of a second file to the open document. Splitting does the inverse: a page ' +
      'range such as 1-3, 5 becomes a brand new file while the open document stays untouched. Both flows ' +
      'go through pdf-lib copyPages, which carries over fonts, images and vector content.',
    MARGIN, y, 11, 16, INK,
  );
  y -= 18;
  const rows = [
    ['Operation', 'Source', 'Result'],
    ['Merge', 'Open document + picked file', 'Pages appended at the end'],
    ['Split', 'Open document', 'New file with the chosen range'],
    ['Save', 'Open document', 'Annotations flattened into the file'],
  ];
  const colX = [MARGIN, MARGIN + 150, MARGIN + 320];
  const rowH = 26;
  rows.forEach((row, ri) => {
    const ry = y - ri * rowH;
    if (ri === 0) {
      page.drawRectangle({ x: MARGIN, y: ry - rowH + 8, width: PAGE_W - 2 * MARGIN, height: rowH, color: rgb(0.95, 0.96, 0.98) });
    }
    row.forEach((cell, ci) => {
      page.drawText(cell, { x: colX[ci] + 8, y: ry - 10, size: 10, font: ri === 0 ? bold : helvetica, color: INK });
    });
    page.drawLine({ start: { x: MARGIN, y: ry - rowH + 8 }, end: { x: PAGE_W - MARGIN, y: ry - rowH + 8 }, thickness: 0.5, color: RULE });
  });
  y -= rows.length * rowH + 22;
  drawParagraph(
    page, helvetica,
    'One more needle for the collection, tucked into section three so that match navigation crosses a ' +
      'page boundary when stepping through results.',
    MARGIN, y, 11, 16, INK,
  );
  drawFooter(page, helvetica, 4, TOTAL);
}

// --------------------------------------------------------------- page 5
{
  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawText('4  Annotations', { x: MARGIN, y: PAGE_H - 84, size: 18, font: bold, color: INK });
  page.drawLine({ start: { x: MARGIN, y: PAGE_H - 96 }, end: { x: PAGE_W - MARGIN, y: PAGE_H - 96 }, thickness: 0.7, color: RULE });
  let y = PAGE_H - 128;
  y = drawParagraph(
    page, helvetica,
    'Highlights, freehand ink, sticky notes and rectangles live on an overlay above the rendered page ' +
      'while you edit. On save they are flattened: drawn into the page content stream so any other PDF ' +
      'viewer shows them identically. Colors and stroke widths chosen in the toolbar are baked in too.',
    MARGIN, y, 11, 16, INK,
  );
  y -= 16;
  y = drawParagraph(
    page, helvetica,
    'The fifth needle hides here on page five. Highlight this sentence with the marker tool, circle the ' +
      'word needle with the pen, then save and reopen the file to confirm the marks became permanent.',
    MARGIN, y, 11, 16, INK,
  );
  y -= 30;
  page.drawText('Try it above:', { x: MARGIN, y, size: 12, font: bold, color: INK });
  y -= 8;
  page.drawRectangle({ x: MARGIN, y: y - 150, width: PAGE_W - 2 * MARGIN, height: 150, borderColor: RULE, borderWidth: 1, borderRadius: 4 });
  page.drawText('scratch space', { x: MARGIN + 12, y: y - 22, size: 9, font: helvetica, color: GRAY });
  drawFooter(page, helvetica, 5, TOTAL);
}

// --------------------------------------------------------------- page 6
{
  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawText('Notes', { x: MARGIN, y: PAGE_H - 84, size: 18, font: bold, color: INK });
  page.drawLine({ start: { x: MARGIN, y: PAGE_H - 96 }, end: { x: PAGE_W - MARGIN, y: PAGE_H - 96 }, thickness: 0.7, color: RULE });
  for (let i = 0; i < 12; i += 1) {
    const ly = PAGE_H - 140 - i * 34;
    page.drawLine({ start: { x: MARGIN, y: ly }, end: { x: PAGE_W - MARGIN, y: ly }, thickness: 0.5, color: RULE });
  }
  drawFooter(page, helvetica, 6, TOTAL);
}

const bytes = await doc.save();
const sampleDir = path.join(root, 'sample');
const publicDir = path.join(root, 'public');
await mkdir(sampleDir, { recursive: true });
await mkdir(publicDir, { recursive: true });
const out = path.join(sampleDir, 'sample.pdf');
await writeFile(out, bytes);
await copyFile(out, path.join(publicDir, 'sample.pdf'));
console.log(`wrote ${out} (${bytes.length} bytes) and public/sample.pdf`);
