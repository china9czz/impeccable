#!/usr/bin/env node
/**
 * Vendor OCR runtime assets into public/ for offline use:
 *   - public/tessdata/{eng,chi_sim}.traineddata.gz  (~30 MB)
 *   - public/tesseract/{worker,core}                 (~8 MB)
 *
 *   node scripts/vendor-tessdata.mjs
 */
import { createWriteStream, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const tessDir = path.join(root, 'public', 'tessdata');
const runtimeDir = path.join(root, 'public', 'tesseract');
mkdirSync(tessDir, { recursive: true });
mkdirSync(runtimeDir, { recursive: true });

const BASE = 'https://cdn.jsdelivr.net/gh/naptha/tessdata@gh-pages/4.0.0';
const LANGS = ['eng', 'chi_sim'];

async function fetchOne(lang) {
  const name = `${lang}.traineddata.gz`;
  const dest = path.join(tessDir, name);
  if (existsSync(dest)) {
    console.log(`skip ${name} (already present)`);
    return;
  }
  const url = `${BASE}/${name}`;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  console.log(`wrote ${dest}`);
}

for (const lang of LANGS) await fetchOne(lang);

// Copy worker + wasm next to tessdata so paths stay un-hashed (Vite would
// otherwise fingerprint node_modules imports and break importScripts).
const copies = [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm', 'tesseract-core-simd-lstm.wasm'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm', 'tesseract-core-lstm.wasm'],
];
for (const [pkgPath, name] of copies) {
  const src = require.resolve(pkgPath);
  const dest = path.join(runtimeDir, name);
  copyFileSync(src, dest);
  console.log(`copied ${name}`);
}

console.log('OCR assets ready under public/tessdata/ and public/tesseract/');
