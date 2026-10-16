import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels, type OpenedFile, type PdfEditorApi } from '../shared/ipc';

const api: PdfEditorApi = {
  openPdfDialog: () => ipcRenderer.invoke(IpcChannels.openPdfDialog) as Promise<OpenedFile | null>,
  savePdfDialog: (defaultName: string) =>
    ipcRenderer.invoke(IpcChannels.savePdfDialog, defaultName) as Promise<string | null>,
  readFile: (path: string) => ipcRenderer.invoke(IpcChannels.readFile, path) as Promise<Uint8Array>,
  writeFile: (path: string, data: Uint8Array) =>
    ipcRenderer.invoke(IpcChannels.writeFile, path, data) as Promise<void>,
  getInitialFile: () => ipcRenderer.invoke(IpcChannels.getInitialFile) as Promise<OpenedFile | null>,
  notifyRendered: () => {
    ipcRenderer.send(IpcChannels.notifyRendered);
  },
};

contextBridge.exposeInMainWorld('pdfEditor', api);
