#!/usr/bin/env node
/**
 * Download Tesseract traineddata packs (eng + chi_sim) into public/tessdata/
 * for offline OCR. Files are gitignored (~30 MB gzipped); run once after clone:
 *
 *   node scripts/vendor-tessdata.mjs
 */
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public', 'tessdata');
const BASE = 'https://cdn.jsdelivr.net/gh/naptha/tessdata@gh-pages/4.0.0';
const LANGS = ['eng', 'chi_sim'];

mkdirSync(outDir, { recursive: true });

async function fetchOne(lang) {
  const name = `${lang}.traineddata.gz`;
  const dest = path.join(outDir, name);
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
console.log('tessdata ready under public/tessdata/');
