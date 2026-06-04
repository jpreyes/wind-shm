const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFile:   ()                          => ipcRenderer.invoke('dialog:open'),
  saveFileAs: (defaultName)               => ipcRenderer.invoke('dialog:saveAs', defaultName),
  writeFile:  (filePath, content)         => ipcRenderer.invoke('file:write', filePath, content),
  onMenu: (channel, cb) => {
    const valid = ['menu:new', 'menu:open', 'menu:save', 'menu:undo', 'menu:redo'];
    if (valid.includes(channel)) ipcRenderer.on(channel, (_e, ...args) => cb(...args));
  },
});
