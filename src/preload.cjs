const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('vi', {
  audio: (bytes) => ipcRenderer.send('audio', bytes),
  finish: () => ipcRenderer.invoke('finish'),
  onPhase: (callback) => ipcRenderer.on('phase', (_event, value) => callback(value)),
});
