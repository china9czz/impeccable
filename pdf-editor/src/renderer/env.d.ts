/// <reference types="vite/client" />

import type { PdfEditorApi } from '../shared/ipc';
import type { EditorStore } from './pdfcore/store';

declare global {
  interface Window {
    /** Injected by the Electron preload script; absent in plain browsers. */
    pdfEditor?: PdfEditorApi;
    /** Debug/testing handle on the editor store, set by StoreProvider. */
    __vellumStore?: EditorStore;
  }
}

export {};
