const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('floatingVoice', {
  onStatus: (listener) => ipcRenderer.on('status', (_event, value) => listener(value)),
  onMeter: (listener) => ipcRenderer.on('meter', (_event, level) => listener(level)),
  onPointerDown: (listener) => ipcRenderer.on('overlay-pointer-down', (_event, point) => listener(point)),
  onPointerCancel: (listener) => ipcRenderer.on('overlay-pointer-cancel', () => listener()),
  stop: () => ipcRenderer.invoke('overlay-stop'),
  cancel: () => ipcRenderer.invoke('cancel'),
  drag: (action) => ipcRenderer.invoke('overlay-drag', action),
});
