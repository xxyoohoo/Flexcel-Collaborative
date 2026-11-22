'use strict';

const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const allowedFlowPages = new Set([
  'pf-flow.html',
  'plan-flow.html',
  'traditional-flow.html',
  'policy-flow-dynamic.html'
]);

let mainWindow = null;

ipcMain.handle('flexcel:open-flow', async (event, page) => {
  if (typeof page !== 'string' || !allowedFlowPages.has(page)) {
    throw new Error('Unsupported flow page');
  }

  const currentWindow = BrowserWindow.fromWebContents(event.sender);
  if (!currentWindow) {
    throw new Error('Flexcel window not found');
  }

  currentWindow.setResizable(true);
  currentWindow.setMaximizable(true);
  currentWindow.maximize();
  await currentWindow.loadFile(path.join(__dirname, page));
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 700,
    height: 450,
    show: false,
    resizable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'main-menu.html'))
    .then(() => mainWindow.show())
    .catch((error) => console.error('Flexcel failed to load:', error));

  if (process.env.FLEXCEL_DEBUG === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});


// FLEXCEL_PF_FILES_PHASE2_BEGIN
// Narrow IPC endpoints for the Public Forum editor. No Node APIs exposed to the page.
{
  const pfFs = require('node:fs/promises');
  const pfPath = require('node:path');
  const { dialog: pfDialog, BrowserWindow: PFWindow } = require('electron');
  const pfMaxBytes = 8 * 1024 * 1024;

  function pfWindow(event) {
    const win = PFWindow.fromWebContents(event.sender);
    const sourceURL = new URL(event.sender.getURL());
    if (!win || sourceURL.protocol !== 'file:' ||
        pfPath.basename(decodeURIComponent(sourceURL.pathname)) !== 'pf-flow.html') {
      throw new Error('PF file operations are only available in the PF editor');
    }
    return win;
  }

  function validatePF(flow) {
    if (!flow || typeof flow !== 'object' || Array.isArray(flow) ||
        flow.flow_type !== 'PF Flow' ||
        !Array.isArray(flow['flow-data']) || flow['flow-data'].length !== 2 ||
        !['Pro', 'Con'].includes(flow.firstSpeaker)) {
      throw new Error('This is not a supported Flexcel Public Forum flow');
    }
    for (const grid of flow['flow-data']) {
      if (!Array.isArray(grid) || grid.length < 1 || grid.length > 250) {
        throw new Error('Invalid flow grid size');
      }
      for (const row of grid) {
        if (!Array.isArray(row) || row.length > 30 || row.some(cell =>
            cell !== null &&
            !(['string', 'number', 'boolean'].includes(typeof cell)) ||
            (typeof cell === 'string' && cell.length > 20000))) {
          throw new Error('Invalid cell contents in flow');
        }
      }
    }
    if (flow.boldElements !== undefined &&
        (!Array.isArray(flow.boldElements) || flow.boldElements.length !== 2 ||
         flow.boldElements.some(side => !Array.isArray(side) || side.length > 2000 ||
           side.some(rc => !Array.isArray(rc) || rc.length !== 2 ||
              !rc.every(Number.isInteger))))) {
      throw new Error('Invalid bold-cell data');
    }
  }

  ipcMain.handle('flexcel:pf-save', async (event, flow) => {
    const win = pfWindow(event);
    validatePF(flow);
    const json = JSON.stringify(flow, null, 2);
    if (Buffer.byteLength(json, 'utf8') > pfMaxBytes) {
      throw new Error('Flow is larger than the maximum supported size (8 MB)');
    }
    const answer = await pfDialog.showSaveDialog(win, {
      title: 'Save Public Forum flow',
      defaultPath: 'PF Round.json',
      filters: [{ name: 'Flexcel Flow', extensions: ['json'] }]
    });
    if (answer.canceled || !answer.filePath) return { canceled: true };
    await pfFs.writeFile(answer.filePath, json, 'utf8');
    return { canceled: false, name: pfPath.basename(answer.filePath) };
  });

  ipcMain.handle('flexcel:pf-open', async event => {
    const win = pfWindow(event);
    const answer = await pfDialog.showOpenDialog(win, {
      title: 'Open Public Forum flow',
      properties: ['openFile'],
      filters: [{ name: 'Flexcel Flow', extensions: ['json'] }]
    });
    if (answer.canceled || !answer.filePaths.length) return { canceled: true };
    const filename = answer.filePaths[0];
    if (pfPath.extname(filename).toLowerCase() !== '.json') {
      throw new Error('Please select a .json Flexcel flow');
    }
    const stat = await pfFs.stat(filename);
    if (stat.size > pfMaxBytes) throw new Error('File is larger than 8 MB');
    const flow = JSON.parse(await pfFs.readFile(filename, 'utf8'));
    validatePF(flow);
    return { canceled: false, name: pfPath.basename(filename), flow };
  });
}
// FLEXCEL_PF_FILES_PHASE2_END
