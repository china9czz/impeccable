/**
 * Lazy loader for the bundled CJK font (Noto Sans SC subset, SIL OFL 1.1).
 *
 * The font is only needed when saving a document that contains non-WinAnsi
 * text, and loading 6 MB must never block app startup, so the bytes are
 * fetched in the background after a document opens and awaited only at save
 * time. While the font is unavailable the save path falls back to the old
 * "?" substitution for out-of-range characters and the UI says so.
 */

export type CjkFontStatus = 'loading' | 'ready' | 'error';

export interface CjkFontResult {
  status: CjkFontStatus;
  bytes: Uint8Array | null;
}

const fontUrl = new URL('../assets/fonts/NotoSansSC-Regular.subset.otf', import.meta.url).href;

let pending: Promise<CjkFontResult> | null = null;
const listeners = new Set<(result: CjkFontResult) => void>();
let lastResult: CjkFontResult | null = null;

/** Start (or join) the background fetch. Safe to call repeatedly. */
export function loadCjkFont(): Promise<CjkFontResult> {
  if (lastResult) return Promise.resolve(lastResult);
  if (!pending) {
    pending = (async (): Promise<CjkFontResult> => {
      try {
        const response = await fetch(fontUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length < 100_000) throw new Error('font file looks truncated');
        return { status: 'ready', bytes };
      } catch {
        return { status: 'error', bytes: null };
      }
    })().then((result) => {
      lastResult = result;
      pending = null;
      for (const listener of listeners) listener(result);
      return result;
    });
  }
  return pending;
}

/** Subscribe to the one-shot load completion. */
export function onCjkFontLoaded(listener: (result: CjkFontResult) => void): () => void {
  listeners.add(listener);
  if (lastResult) listener(lastResult);
  return () => {
    listeners.delete(listener);
  };
}

/** True when every character fits the WinAnsi encoding of the base-14 fonts. */
export function isWinAnsi(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[^\x20-\x7E\xA0-\xFF]/.test(text);
}

/**
 * pdf.js and the saved PDF both need real text: pick the CJK font for any
 * run containing characters outside WinAnsi, Helvetica otherwise. Noto Sans
 * SC covers Latin glyphs too, so mixed runs stay in one font.
 */
export function needsCjk(text: string): boolean {
  return !isWinAnsi(text);
}
