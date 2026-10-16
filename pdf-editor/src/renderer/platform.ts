import type { OpenedFile, PdfEditorApi } from '../shared/ipc';

/**
 * Platform bridge. Inside Electron the preload script exposes window.pdfEditor
 * with native dialogs and real file IO. When the renderer runs in a plain
 * browser (used by the Playwright verification harness and for quick UI
 * development) we fall back to file inputs, downloads and an optional sample
 * document served from the dev server (?sample=1 or ?sample=path.pdf).
 */
export function getPlatform(): PdfEditorApi {
  if (typeof window !== 'undefined' && window.pdfEditor) return window.pdfEditor;
  return browserFallbackApi;
}

export function isElectron(): boolean {
  return typeof window !== 'undefined' && Boolean(window.pdfEditor);
}

const browserFallbackApi: PdfEditorApi = {
  openPdfDialog(): Promise<OpenedFile | null> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/pdf,.pdf';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        resolve({ path: '', name: file.name, data: new Uint8Array(await file.arrayBuffer()) });
      };
      input.click();
    });
  },

  savePdfDialog(): Promise<string | null> {
    // No native dialog in a browser; callers treat null as "download".
    return Promise.resolve(null);
  },

  readFile(): Promise<Uint8Array> {
    return Promise.reject(new Error('readFile is not available outside Electron'));
  },

  writeFile(path: string, data: Uint8Array): Promise<void> {
    const blob = new Blob([data as BlobPart], { type: 'application/pdf' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = path.split(/[\\/]/).pop() ?? 'document.pdf';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 10_000);
    return Promise.resolve();
  },

  async getInitialFile(): Promise<OpenedFile | null> {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('sample')) return null;
    const raw = params.get('sample');
    const url = raw && raw !== '1' && raw !== 'true' ? raw : 'sample.pdf';
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      return {
        path: '',
        name: url.split('/').pop() ?? 'sample.pdf',
        data: new Uint8Array(await response.arrayBuffer()),
      };
    } catch {
      return null;
    }
  },

  notifyRendered(): void {
    // The web harness polls the DOM instead of listening for this signal.
  },
};
