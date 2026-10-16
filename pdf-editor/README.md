# Vellum PDF Editor

A desktop PDF editor MVP in the spirit of Acrobat and Foxit, built from scratch with
Electron, TypeScript, React and Vite. Rendering is done by pdf.js (`pdfjs-dist`),
document manipulation by `pdf-lib`. The UI is hand-written CSS, no framework.

![Vellum PDF Editor](docs/screenshot-v1.png)

## Features

- **Open / Save / Save as.** Native file dialogs; saving bakes every change into
  the file. Drag-and-drop a PDF anywhere in the window also works.
- **Reading view.** Continuous vertical scroll, zoom in/out, fit width, fit page,
  preset zoom levels, numeric page navigation, and a thumbnail sidebar that stays
  in sync with the document.
- **Text search.** In-document search with per-word match highlighting on the page,
  match counter, and next/previous navigation (Enter / Shift+Enter) that scrolls
  to the match.
- **Page operations.** Rotate left/right, delete page, insert blank page (inherits
  the current page size), and drag-to-reorder in the thumbnail sidebar.
- **Merge and split.** Append another PDF to the open document; export a page range
  like `1-3, 5` as a new PDF without touching the open one.
- **Annotations.** Highlight, freehand pen, sticky note and rectangle tools with
  color and stroke-width options. Drawn on an SVG overlay while editing and
  flattened into the page content stream on save.
- **Add and edit text.** Click anywhere to place a text box with font-size and
  color options, including CJK text (bundled Noto Sans SC). Existing text boxes
  can be moved, edited and restyled; they are flattened into the PDF on save.
- **OCR.** Recognize text on scanned / image-only pages with tesseract.js
  (`chi_sim` + `eng`). Toolbar actions run OCR on the current page or the whole
  document, with a status-bar progress indicator. Recognized words become an
  overlay you can search immediately; on save they flatten to an invisible
  extractable text layer so reopen keeps Chinese and English searchable.
- **Electronic signature.** Draw a signature or upload PNG/SVG, place it on a
  page with drag/resize, or stamp every page at once. Signatures can be reused
  from `localStorage` within the browser profile. Place / move / delete go
  through the same undo/redo stack as other annotations; save flattens the
  image into the page.
- **Undo/redo.** Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or Ctrl+Y) cover every edit:
  annotation create/edit/move/delete, rotate, delete, insert, reorder, merge,
  OCR overlays and signatures. Toolbar buttons show the same state. See
  "Undo model" below for the rules.
- **Keyboard.** Ctrl/Cmd+O open, Ctrl/Cmd+S save, Ctrl/Cmd+Shift+S save as,
  Ctrl/Cmd+F search, Ctrl/Cmd +/- zoom, Delete removes the selected annotation.

## Requirements

- Node.js 20+
- Linux: an X11/Wayland session for the Electron window (or `xvfb-run` for
  headless runs)

## Setup

```bash
npm install
```

If the Electron binary is missing afterwards (some CI environments skip binary
downloads), run `node node_modules/electron/install.js` once.

## Run

```bash
npm run dev          # Vite dev server + Electron with esbuild watch for main/preload
npm start            # run the production build (after npm run build)
npm start -- path/to/file.pdf   # open a file directly
```

## Build and checks

```bash
npm run typecheck    # strict tsc, main/preload config + renderer config
npm run build        # typecheck + esbuild (main, preload) + vite (renderer)
npm run make-sample  # generate sample/sample.pdf (6 pages, searchable text)
npm run smoke-ops    # Node-level sanity test of every pdf-lib operation used
```

## Verification harnesses

Two headless harnesses prove the app works end to end:

```bash
npm run screenshot       # real Electron window -> artifacts/screenshot.png
npm run screenshot:web   # renderer preview via headless Chrome -> artifacts/
npm run test:e2e         # 23 functional checks driven through the real UI
```

- `screenshot` launches the packaged app, auto-opens the sample PDF and captures
  the window. It needs a display (`xvfb-run` is used automatically when
  `DISPLAY` is unset).
- `screenshot:web` and `test:e2e` use the same built renderer inside headless
  Chrome through the browser platform fallback. `test:e2e` exercises search,
  all five annotation tools, rotate/insert/delete/reorder, merge, split and
  save-with-flatten, then re-parses the downloaded PDFs in Node to confirm the
  flattened content is real, extractable text.

Note: in restricted sandboxes (gVisor-style), Electron's Chromium cannot create
shared memory and the renderer crashes; use the `*:web` harnesses there. On a
normal desktop, `npm run dev` and `npm start` work directly.

## Packaging (Windows)

electron-builder produces Windows artifacts from any OS:

```bash
npm run dist:win    # build + package -> release/
```

Outputs (x64):

- `release/Vellum PDF Setup <version>.exe` — NSIS installer (default target;
  lets the user pick the install directory, creates a Start Menu shortcut).
- `release/Vellum PDF-<version>-win.zip` — portable build, no install needed.

Building NSIS on Linux/macOS needs Wine (`sudo apt install wine wine32:i386`
on Ubuntu, with the i386 architecture enabled); without it electron-builder
fails while editing the installer metadata. The zip target works Wine-free on
older electron-builder versions but current versions also shell out to Wine
for the executable, so install Wine either way. Artifacts are unsigned; Windows
SmartScreen will warn until the app is code-signed.

## Project layout

```
src/
  main/        Electron main process: window, dialogs, fs IPC, screenshot hook
  preload/     contextBridge exposing the typed window.pdfEditor API
  shared/      IPC channel names and payload types shared by all three sides
  renderer/
    pdfcore/   UI-independent core: pdf.js loading/rendering, text extraction,
               annotation types, coordinate helpers, flatten-to-PDF, EditorStore
    state/     React context binding (useSyncExternalStore)
    components/Toolbar, AnnotationToolBar, Sidebar, PageView, AnnotationLayer,
               SplitDialog, icons
scripts/       dev/build/sample/smoke/screenshot/e2e runners (plain Node)
sample/        generated sample PDF used by the harnesses
```

### How the pieces fit

One document lives in two forms: a pdf.js `PDFDocumentProxy` for rendering and
text extraction, and a pdf-lib `PDFDocument` for manipulation. Every structural
edit (rotate, delete, insert, reorder, merge) mutates the pdf-lib document,
re-serializes it, and reloads the pdf.js side. Pages carry stable internal IDs
so annotations survive reordering. Annotations are stored in PDF user-space
coordinates (bottom-left origin, rotation independent) and converted through
the pdf.js viewport, so they land correctly at any zoom or rotation. On save,
`flatten.ts` redraws them into a fresh copy of the document with pdf-lib.

The preload bridge is the only renderer-to-OS channel (context isolation on,
node integration off). A browser fallback implementation of the same API lets
the renderer run standalone for development and for the headless harnesses.

## OCR (scanned pages)

Uses [tesseract.js](https://github.com/naptha/tesseract.js) in the renderer with
Chinese Simplified + English (`chi_sim+eng`).

**Language packs.** Packs are not committed (they are ~30 MB gzipped). After
clone, run:

```bash
npm run vendor-tessdata   # -> public/tessdata/{eng,chi_sim}.traineddata.gz
```

The OCR worker loads packs from `./tessdata` first (offline). If the folder is
empty, tesseract.js will attempt its default CDN download on first use (needs
network once, then caches).

**Limits.**

- Accuracy depends on scan quality, DPI, and contrast. The harness renders each
  page at 2× before recognition; very small type or heavy skew will miss words.
- Whole-document OCR is sequential and CPU-heavy; large books can take minutes.
- OCR results are stored as page overlays until Save, then written as
  **invisible** text (opacity 0) so the page look stays unchanged while search
  and copy still work after reopen.
- Confidence filter drops words below ~35; garbage glyphs are still possible on
  noisy scans — spot-check before shipping a filed document.
- Only `chi_sim` and `eng` are wired. Other languages need another traineddata
  pack in `public/tessdata/` and a code change to the `LANG` constant in
  `src/renderer/pdfcore/ocr.ts`.

## Electronic signature

Open **Sign** in the toolbar to draw on the pad or upload a PNG/SVG (SVG is
rasterized to PNG for embedding). Then click a page to place, or use **Stamp
all** on a saved signature to drop the same image on every page (lower-right
margin). Drag to move; the corner handle resizes. Saved strokes live in
`localStorage` (`vellum.signatures.v1`, up to 8) for the current browser
profile — not synced across machines. Flatten on save embeds the PNG via
pdf-lib; this is an electronic image stamp, not a cryptographic digital
signature (certificate-based signing is out of scope).

## CJK / Unicode text

Text boxes and sticky notes support Chinese (and any other BMP character
covered by Noto Sans SC). A subset of Noto Sans SC (SIL OFL 1.1, see
`src/renderer/assets/fonts/OFL.txt`) is bundled at
`src/renderer/assets/fonts/NotoSansSC-Regular.subset.otf` (~6 MB): Latin,
punctuation, fullwidth forms, and the complete U+4E00-9FFF ideograph block.

- The font is fetched **in the background** after startup; it never blocks
  the app. The status bar shows `Loading CJK font…` until it is ready.
- On save, text runs that fit WinAnsi use the standard Helvetica; runs with
  CJK characters switch to the embedded Noto font, embedded **subset to the
  glyphs actually used** (via `@pdf-lib/fontkit`), so saved files stay small.
- If the font fails to load, saving still works: out-of-range characters fall
  back to `?` and the status bar warns (`CJK font unavailable`).
- To regenerate or upgrade the font: `node scripts/vendor-font.mjs`
  (requires `pip install fonttools`; downloads Noto Sans SC and subsets it
  with `--desubroutinize`, which avoids a pdf.js subrIndex rendering warning).

## Undo model

Every reversible mutation (annotation add/edit/delete/move, rotate, delete,
insert blank, reorder, merge) is one history entry; Ctrl/Cmd+Z walks back and
Ctrl/Cmd+Shift+Z / Ctrl+Y replays. The rules:

- **Saving does not clear history.** The dirty flag is revision-based: it is
  set whenever the working state differs from the last saved state, so undoing
  all the way back to the save point correctly shows a clean document.
- **Rapid gestures coalesce.** Dragging a text box, dragging a color picker or
  nudging font size records a single entry per gesture (1.2 s window), not one
  per pointer event.
- Deleted pages are stored as single-page PDF bytes in the entry, so undo
  restores them byte-identical with their annotations. Merge entries keep the
  source file's bytes for redo — merging a very large file and keeping it in
  history costs that much memory until the 100-entry limit pushes it out.
- History is capped at 100 entries and resets when a document is opened.
- Split (export a range) does not modify the open document and is not an undo
  entry; it produces a separate file.

## Known limitations vs a full Acrobat-class editor

- One CJK font weight (Regular) is bundled; bold/italic text flattens in
  Regular. Rare extension-B+ ideographs outside U+4E00-9FFF/F900-FAFF are not
  covered.
- No multi-page selection for bulk rotate/delete.
- Rectangle, pen and highlight annotations can be deleted and recolored but not
  moved or resized; notes and text boxes are movable.
- Sticky notes flatten as visible marker + text (real popup annotation objects
  are not created).
- Search operates on the extracted text layer plus any OCR overlays that have
  not been saved yet. Run **OCR page** / **OCR all** on scanned PDFs first.
- Coordinate mapping assumes pages whose MediaBox starts at the origin, which
  covers virtually all office PDFs but not every print-shop file.
- Very large documents (hundreds of pages) work, but thumbnail rendering is
  on-demand only and there is no tile caching beyond pdf.js defaults.
- The window has no native application menu; everything lives in the toolbars.
