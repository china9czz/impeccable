import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { IpcChannels, type OpenedFile } from '../shared/ipc';

/**
 * Verification harness support: when PDF_EDITOR_SCREENSHOT is set the app runs
 * unattended (no-sandbox for containers), opens PDF_EDITOR_AUTOOPEN (or the
 * first .pdf argv), waits for the renderer's first-render signal, captures the
 * window and quits. Used by scripts/screenshot.mjs.
 */
const screenshotPath = process.env.PDF_EDITOR_SCREENSHOT ?? null;
const autoOpenPath = process.env.PDF_EDITOR_AUTOOPEN ?? argvPdfPath();

function argvPdfPath(): string | null {
  for (const arg of process.argv.slice(1)) {
    if (!arg.startsWith('-') && /\.pdf$/i.test(arg)) return path.resolve(arg);
  }
  return null;
}

if (screenshotPath) {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
}

let mainWindow: BrowserWindow | null = null;

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#17191d',
    title: 'Vellum PDF',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The packaged app loads over file:// and pdf.js spawns its worker as an
      // ES module, which Chromium refuses on file origins. This is a local
      // document tool with no remote content, so relaxing webSecurity is an
      // acceptable MVP trade-off (documented in the README).
      webSecurity: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    await mainWindow.loadURL(devUrl);
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannels.openPdfDialog, async (): Promise<OpenedFile | null> => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open PDF',
      properties: ['openFile'],
      filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
    });
    const filePath = result.filePaths[0];
    if (result.canceled || !filePath) return null;
    const data = await readFile(filePath);
    return { path: filePath, name: path.basename(filePath), data };
  });

  ipcMain.handle(IpcChannels.savePdfDialog, async (_event, defaultName: string): Promise<string | null> => {
    if (!mainWindow) return null;
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save PDF',
      defaultPath: defaultName,
      filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
    });
    return result.canceled || !result.filePath ? null : result.filePath;
  });

  ipcMain.handle(IpcChannels.readFile, (_event, filePath: string) => readFile(filePath));

  ipcMain.handle(IpcChannels.writeFile, async (_event, filePath: string, data: Uint8Array) => {
    await writeFile(filePath, Buffer.from(data));
  });

  ipcMain.handle(IpcChannels.getInitialFile, async (): Promise<OpenedFile | null> => {
    if (!autoOpenPath) return null;
    try {
      const data = await readFile(autoOpenPath);
      return { path: autoOpenPath, name: path.basename(autoOpenPath), data };
    } catch {
      return null;
    }
  });

  ipcMain.on(IpcChannels.notifyRendered, () => {
    void captureVerificationScreenshot();
  });
}

let screenshotTaken = false;

async function captureVerificationScreenshot(): Promise<void> {
  if (!screenshotPath || !mainWindow || screenshotTaken) return;
  screenshotTaken = true;
  // Give thumbnails and later pages a moment to paint after the first signal.
  setTimeout(() => {
    void (async () => {
      try {
        const image = await mainWindow!.webContents.capturePage();
        await writeFile(screenshotPath!, image.toPNG());
        console.log(`[screenshot] wrote ${screenshotPath}`);
        app.exit(0);
      } catch (error) {
        console.error('[screenshot] failed', error);
        app.exit(1);
      }
    })();
  }, 1500);
}

void app.whenReady().then(() => {
  registerIpcHandlers();
  void createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
