/**
 * Shared IPC contract between the Electron main process, the preload bridge
 * and the renderer. Kept dependency-free so all three tsconfigs can use it.
 */

export const IpcChannels = {
  openPdfDialog: 'dialog:open-pdf',
  savePdfDialog: 'dialog:save-pdf',
  readFile: 'file:read',
  writeFile: 'file:write',
  getInitialFile: 'app:get-initial-file',
  notifyRendered: 'app:rendered',
} as const;

export interface OpenedFile {
  /** Absolute path on disk. Empty string for files not backed by a path (browser fallback). */
  path: string;
  /** Base file name, used for titles and suggested save names. */
  name: string;
  /** Raw PDF bytes. */
  data: Uint8Array;
}

export interface PdfEditorApi {
  /** Show a native open dialog and read the chosen PDF. Null when cancelled. */
  openPdfDialog(): Promise<OpenedFile | null>;
  /** Show a native save dialog. Null when cancelled. */
  savePdfDialog(defaultName: string): Promise<string | null>;
  /** Read a file from disk (used for files opened via argv / OS association). */
  readFile(path: string): Promise<Uint8Array>;
  /** Write bytes to disk. In the browser fallback this triggers a download. */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** File the OS asked us to open (argv). Null when the app was started bare. */
  getInitialFile(): Promise<OpenedFile | null>;
  /** One-shot signal used by the headless screenshot harness. */
  notifyRendered(): void;
}
