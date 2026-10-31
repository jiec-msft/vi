const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('recorder', {
  frame: (callback) => ipcRenderer.on('frame', (_event, png) => callback(png)),
  stop: (callback) => ipcRenderer.on('stop-video', callback),
  chunk: (bytes) => ipcRenderer.send('video-chunk', bytes),
  done: () => ipcRenderer.send('video-done'),
});
