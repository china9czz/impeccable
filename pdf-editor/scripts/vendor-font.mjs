#!/usr/bin/env node
/**
 * Reproducible pipeline for the bundled CJK font. The output is committed to
 * the repo, so this only needs to run when upgrading the font.
 *
 * Steps: download Noto Sans SC (SIL OFL 1.1) from the notofonts/noto-cjk
 * mirror, subset it with pyftsubset (pip install fonttools) to the ranges the
 * editor can emit, and write src/renderer/assets/fonts/.
 *
 * Ranges kept: Latin + punctuation + the full CJK Unified Ideographs block
 * (U+4E00-9FFF, 20992 chars) plus compatibility ideographs and fullwidth
 * forms, so no BMP Chinese character can be missed. --desubroutinize avoids a
 * pdf.js "Out of bounds subrIndex" rendering warning on fonts subsetted again
 * at save time by fontkit.
 *
 *   node scripts/vendor-font.mjs
 */
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { get } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src', 'renderer', 'assets', 'fonts');
const SOURCE_URL =
  'https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf';
const LICENSE_URL = 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/notosanssc/OFL.txt';

const UNICODES = [
  'U+0020-007E', // basic Latin
  'U+00A0-00FF', // Latin-1 supplement
  'U+2000-206F', // general punctuation
  'U+2100-214F', // letterlike symbols
  'U+2160-218F', // roman numerals
  'U+2190-21FF', // arrows
  'U+2460-24FF', // enclosed alphanumerics
  'U+25A0-25FF', // geometric shapes
  'U+3000-303F', // CJK punctuation
  'U+4E00-9FFF', // CJK unified ideographs
  'U+F900-FAFF', // compatibility ideographs
  'U+FF00-FFEF', // fullwidth forms
].join(',');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`download failed: HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

mkdirSync(outDir, { recursive: true });
const full = path.join(outDir, 'NotoSansSC-Regular.full.otf');
const subset = path.join(outDir, 'NotoSansSC-Regular.subset.otf');

if (!existsSync(full)) {
  console.log(`downloading ${SOURCE_URL}`);
  await download(SOURCE_URL, full);
}
console.log('downloading OFL license');
await download(LICENSE_URL, path.join(outDir, 'OFL.txt'));

console.log('subsetting with pyftsubset (requires: pip install fonttools)');
const result = spawnSync(
  'pyftsubset',
  [
    full,
    `--output-file=${subset}`,
    `--unicodes=${UNICODES}`,
    '--desubroutinize',
  ],
  { stdio: 'inherit' },
);
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`font vendored: ${subset}`);
