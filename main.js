const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs   = require('fs');

const isMac = process.platform === 'darwin';

// ── Main window ────────────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width:     1440,
    height:    900,
    minWidth:  900,
    minHeight: 600,
    show: false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  win.loadFile('index.html');
  win.once('ready-to-show', () => win.show());
  return win;
}

// ── IPC: file dialogs ──────────────────────────────────────────────────────
ipcMain.handle('dialog:open', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog({
    title:      'Abrir modelo',
    filters:    [{ name: 'StructWeb3D', extensions: ['s3d', 'json'] }],
    properties: ['openFile'],
  });
  if (canceled || filePaths.length === 0) return null;
  const filePath = filePaths[0];
  return { content: fs.readFileSync(filePath, 'utf8'), filePath };
});

ipcMain.handle('dialog:saveAs', async (_e, defaultName) => {
  const { filePath, canceled } = await dialog.showSaveDialog({
    title:       'Guardar modelo',
    defaultPath: defaultName ?? 'modelo.s3d',
    filters:     [{ name: 'StructWeb3D', extensions: ['s3d'] }],
  });
  if (canceled || !filePath) return null;
  return filePath;
});

ipcMain.handle('file:write', async (_e, filePath, content) => {
  fs.writeFileSync(filePath, content, 'utf8');
});

// ── Native application menu ────────────────────────────────────────────────
function buildMenu() {
  const send = (channel) => (_, win) => win?.webContents.send(channel);
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'Archivo',
      submenu: [
        { label: 'Nuevo',   accelerator: 'CmdOrCtrl+N', click: send('menu:new')  },
        { label: 'Abrir…',  accelerator: 'CmdOrCtrl+O', click: send('menu:open') },
        { label: 'Guardar', accelerator: 'CmdOrCtrl+S', click: send('menu:save') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: 'Salir' },
      ],
    },
    {
      label: 'Editar',
      submenu: [
        { label: 'Deshacer', accelerator: 'CmdOrCtrl+Z',       click: send('menu:undo') },
        { label: 'Rehacer',  accelerator: 'CmdOrCtrl+Shift+Z', click: send('menu:redo') },
      ],
    },
    {
      label: 'Ver',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Ayuda',
      submenu: [
        {
          label: 'Acerca de StructWeb3D',
          click: async () => dialog.showMessageBox({
            type:    'info',
            title:   'StructWeb3D',
            message: 'StructWeb3D v0.1.0',
            detail:  'Aplicación educativa de análisis estructural 3D.\n\nElectron + Three.js + numeric.js',
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Lifecycle ──────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
