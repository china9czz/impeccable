#!/usr/bin/env node
/**
 * Smoke test for the pdf-core operations, run in plain Node against the
 * generated sample. Verifies the exact pdf-lib call patterns the store uses:
 * rotate, delete, reorder (rebuild via copyPages), insert blank, merge,
 * split-export and annotation flattening primitives.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { degrees, LineCapStyle, PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bytes = await readFile(path.join(root, 'sample', 'sample.pdf'));

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}

// Rotate + delete + insert blank + merge, all in place.
const doc = await PDFDocument.load(bytes);
assert(doc.getPageCount() === 6, 'sample has 6 pages');

const first = doc.getPage(0);
first.setRotation(degrees(((first.getRotation().angle + 90) % 360 + 360) % 360));
assert(first.getRotation().angle === 90, 'rotate to 90');

doc.removePage(3);
assert(doc.getPageCount() === 5, 'removePage drops count');

const { width, height } = doc.getPage(0).getSize();
doc.insertPage(1, [width, height]);
assert(doc.getPageCount() === 6, 'insertPage adds a blank');

const mergeSrc = await PDFDocument.load(bytes);
const copied = await doc.copyPages(mergeSrc, [0, 1]);
for (const page of copied) doc.addPage(page);
assert(doc.getPageCount() === 8, 'merge appends pages');

// Reorder via rebuild (the store's movePage strategy).
const order = [2, 0, 1, 3, 4, 5, 6, 7];
const fresh = await PDFDocument.create();
const reordered = await fresh.copyPages(doc, order);
for (const page of reordered) fresh.addPage(page);
assert(fresh.getPageCount() === 8, 'reorder rebuild keeps count');

// Split export.
const split = await PDFDocument.create();
const splitPages = await split.copyPages(fresh, [0, 2, 4]);
for (const page of splitPages) split.addPage(page);
assert(split.getPageCount() === 3, 'split export has 3 pages');
await split.save();

// Flatten primitives used by flatten.ts.
const font = await fresh.embedFont(StandardFonts.Helvetica);
const target = fresh.getPage(0);
target.drawText('flatten smoke', { x: 40, y: 700, size: 14, font, color: rgb(0.2, 0.2, 0.8) });
target.drawRectangle({ x: 40, y: 640, width: 120, height: 40, borderColor: rgb(1, 0, 0), borderWidth: 2 });
target.drawRectangle({ x: 40, y: 580, width: 120, height: 20, color: rgb(1, 0.85, 0), opacity: 0.35 });
target.drawLine({ start: { x: 40, y: 540 }, end: { x: 220, y: 560 }, thickness: 2.5, color: rgb(0, 0.6, 0), lineCap: LineCapStyle.Round });

const out = await fresh.save();
const check = await PDFDocument.load(out);
assert(check.getPageCount() === 8, 'roundtrip keeps page count');

console.log('smoke-ops OK: rotate, delete, insert, merge, reorder, split, flatten primitives all valid');
