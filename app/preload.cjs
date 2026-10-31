const { contextBridge, ipcRenderer } = require('electron');

const request = async (channel, ...args) => {
  const reply = await ipcRenderer.invoke(channel, ...args);
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
};
contextBridge.exposeInMainWorld('voice', {
  status: () => request('get-status'),
  providerOptions: () => request('get-provider-options'),
  saveProvider: (value) => request('save-provider-options', value),
  ciQuit: () => request('ci-quit'),
  consent: (value) => request('set-consent', value),
  toggle: () => request('toggle'),
  cancel: () => request('cancel'),
  copy: () => request('copy-result'),
  plugins: () => request('get-plugins'),
  setPluginEnabled: (id, enabled) => request('set-plugin-enabled', id, enabled),
  original: () => request('get-original'),
  copyOriginal: () => request('copy-original'),
  preferences: (value) => request('save-preferences', value),
  checkShortcuts: (value) => request('check-shortcuts', value),
  microphonePrivacy: () => request('microphone-privacy'),
  startMicTest: () => request('microphone-test-start'),
  endMicTest: (id) => request('microphone-test-end', id),
  onMicTestStop: (listener) => ipcRenderer.on('microphone-test-stop', (_event, id) => listener(id)),
  onStatus: (listener) => ipcRenderer.on('status', (_event, value) => listener(value)),
  onMeter: (listener) => ipcRenderer.on('meter', (_event, level) => listener(level)),
  onStart: (listener) => ipcRenderer.on('capture-start', (_event, id, sounds, deviceId) => listener(id, sounds, deviceId)),
  onStop: (listener) => ipcRenderer.on('capture-stop', (_event, id) => listener(id)),
  onCancel: (listener) => ipcRenderer.on('capture-cancel', (_event, id, cue) => listener(id, cue)),
  ready: (id) => ipcRenderer.send('capture-ready', id),
  audio: (id, pcm) => ipcRenderer.send('pcm', id, pcm),
  meter: (id, level) => ipcRenderer.send('meter', id, level),
  ended: (id) => ipcRenderer.send('capture-ended', id),
  microphoneError: (id) => ipcRenderer.send('capture-error', id),
});
