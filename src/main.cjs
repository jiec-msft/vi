const { app, BrowserWindow, clipboard, ipcMain, desktopCapturer, globalShortcut, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Provider } = require('./provider.cjs');
const { fakeService } = require('../test/fake-service.cjs');

const mode = process.argv.find((arg) => arg.startsWith('--ci-mode='))?.split('=')[1];
const output = process.env.VI_OUTPUT;
if (!output || !['smoke', 'ui'].includes(mode)) throw new Error('Use the isolated smoke/UI launcher.');
app.setPath('userData', path.join(output, 'profile'));
if (mode === 'ui') {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', path.join(output, 'input.wav'));
  if (process.platform === 'darwin') {
    // The isolated CI fixture file is outside the audio service sandbox.
    app.commandLine.appendSwitch('disable-features', 'AudioServiceSandbox');
  }
}
const report = { platform: process.platform, arch: process.arch, checks: [], videoScope: 'desktop' };
let main, editor, floating, recorder, provider, service, frames, grabbing = false;
const video = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(action, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await action()) return; await pause(50); }
  throw new Error(`Not ready: ${label}`);
}
async function click() {
  const point = await main.webContents.executeJavaScript("(()=>{const r=document.getElementById('toggle').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
  main.focus();
  main.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', ...point, clickCount: 1 });
  main.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', ...point, clickCount: 1 });
}
async function run() {
  assert.equal(process.arch, process.env.VI_EXPECTED_ARCH);
  service = await fakeService();
  provider = new Provider({ endpoint: service.endpoint, credential: 'fixture-credential' });
  provider.on('failure', () => { report.providerFailure = true; });
  await provider.open();
  report.checks.push('native-architecture', 'loopback-provider-start');
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(contents === main?.webContents && permission === 'media' && details.mediaTypes?.every((type) => type === 'audio')));
  main = new BrowserWindow({ x: 20, y: 30, width: 480, height: 380,
    backgroundColor: '#123456', webPreferences: { preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true, contextIsolation: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  await main.loadFile(path.join(__dirname, 'index.html'));
  await until(() => main.webContents.executeJavaScript("document.getElementById('phase').textContent==='Ready'"), 'renderer');
  report.checks.push('renderer-ready');
  if (mode === 'smoke') return;
  editor = new BrowserWindow({ x: 530, y: 30, width: 480, height: 380 });
  await editor.loadURL('data:text/html,<title>VI owned editor</title><textarea id="target" style="width:90%;height:200px;font-size:22px"></textarea>');
  floating = new BrowserWindow({ x: 200, y: 440, width: 224, height: 54, frame: false, focusable: false,
    alwaysOnTop: true, skipTaskbar: true, backgroundColor: '#345678' });
  await floating.loadURL('data:text/html,<title>VI status</title><body style="color:white">Ready</body>');
  editor.focus();
  await pause(200);
  floating.showInactive();
  floating.setPosition(240, 450, false);
  assert.equal(floating.isFocused(), false);
  assert.equal(floating.getBounds().x, 240);
  report.checks.push('nonactivating-window-placement');
  assert.equal(globalShortcut.register('CommandOrControl+Shift+F9', () => {}), true);
  globalShortcut.unregisterAll();
  report.checks.push('os-shortcut-registration');
  recorder = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'recorder-preload.cjs'),
    sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  await recorder.loadFile(path.join(__dirname, 'recorder.html'));
  ipcMain.on('video-chunk', (event, data) => {
    if (event.sender !== recorder.webContents) throw new Error('Untrusted video source.');
    video.push(Buffer.from(data));
  });
  let complete;
  const completed = new Promise((resolve) => { complete = resolve; });
  ipcMain.on('video-done', (event) => { if (event.sender === recorder.webContents) complete(); });
  const capture = async () => {
    if (grabbing) return;
    grabbing = true;
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } });
      assert.ok(sources[0] && !sources[0].thumbnail.isEmpty());
      recorder.webContents.send('frame', sources[0].thumbnail.toPNG());
    } finally { grabbing = false; }
  };
  await capture();
  frames = setInterval(() => { void capture().catch((error) => { report.captureFailure = error.message; }); }, 200);
  ipcMain.on('audio', (event, bytes) => {
    if (event.sender !== main.webContents) throw new Error('Untrusted audio source.');
    provider.audio(Buffer.from(bytes));
  });
  ipcMain.handle('finish', async (event) => {
    if (event.sender !== main.webContents) throw new Error('Untrusted finish request.');
    const text = await provider.finish();
    const written = clipboard.writeText(text);
    report.clipboardAsync = Boolean(written && typeof written.then === 'function');
    await written;
    if (process.platform === 'darwin') app.focus({ steal: true });
    editor.focus();
    await until(() => editor.isFocused(), 'owned editor focus');
    await editor.webContents.executeJavaScript("document.getElementById('target').focus()");
    await pause(100);
    editor.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: [process.platform === 'darwin' ? 'command' : 'control'] });
    editor.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: [process.platform === 'darwin' ? 'command' : 'control'] });
    report.pasteDiagnostics = { clipboardChars: (await clipboard.readText()).length,
      focused: editor.isFocused(), document: await editor.webContents.executeJavaScript("({focused:document.hasFocus(),target:document.activeElement.id})") };
    main.webContents.send('phase', 'Ready');
  });
  await click();
  await until(() => service.bytes() > 0, 'real PCM from fake input');
  report.checks.push('pcm-capture-and-network-delivery');
  await pause(1000);
  await click();
  await until(() => editor.webContents.executeJavaScript("document.getElementById('target').value==='Fixture final text'"), 'actual paste');
  assert.equal(await main.webContents.executeJavaScript('window.__released'), true);
  assert.equal(await main.webContents.executeJavaScript('window.__failure'), undefined);
  report.checks.push('actual-os-clipboard-paste', 'microphone-resources-released');
  await pause(1000);
  clearInterval(frames);
  recorder.webContents.send('stop-video');
  await completed;
  assert.ok(video.length > 0);
  assert.ok(!report.captureFailure);
  await fs.writeFile(path.join(output, 'desktop.webm'), Buffer.concat(video));
  await fs.writeFile(path.join(output, 'desktop.png'), (await desktopCapturer.getSources({
    types: ['screen'], thumbnailSize: { width: 1280, height: 720 } }))[0].thumbnail.toPNG());
  report.audioBytes = service.bytes();
  report.videoBytes = Buffer.concat(video).length;
  report.checks.push('desktop-video');
}
app.whenReady().then(run).then(() => { report.status = 'passed'; }).catch((error) => {
  report.status = 'failed'; report.error = error.message; process.exitCode = 1;
}).finally(async () => {
  clearInterval(frames);
  globalShortcut.unregisterAll();
  provider?.close();
  await service?.close();
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  app.exit(process.exitCode || 0);
});
