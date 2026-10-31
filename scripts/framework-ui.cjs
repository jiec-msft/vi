const { app, BrowserWindow, clipboard, systemPreferences, nativeImage, desktopCapturer, screen } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { recordDesktop } = require('./desktop-evidence.cjs');
const { fiveMarkersVisible } = require('./visible-markers.cjs');

if (process.argv.find((arg) => arg.startsWith('--ci-mode=')) !== '--ci-mode=framework-ui' ||
    !process.env.VI_OUTPUT || !process.env.VI_PROVIDER_DIR) {
  throw new Error('Use the isolated framework UI launcher with a prepared provider.');
}
const directory = path.resolve(process.env.VI_OUTPUT);
const profile = path.join(directory, 'profile');
app.commandLine.appendSwitch('user-data-dir', profile);
app.commandLine.appendSwitch('provider-dir', path.join(directory, 'fixture-provider'));
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', path.join(directory, 'input.wav'));
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('disable-features', 'AudioServiceSandbox');
  // TCC/hardware permission is a separate gate from the synthetic-input UI suite.
  systemPreferences.askForMediaAccess = async (kind) => kind === 'microphone';
}
const report = { platform: process.platform, arch: process.arch, checks: [],
  permissionScope: 'synthetic-input', shortcutScope: 'settings-and-registration' };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let mainWindow, service, stopVideo;
async function until(action, label, limit = 20000) {
  const deadline = Date.now() + limit;
  do {
    if (await action()) return;
    await pause(100);
  } while (Date.now() < deadline);
  throw new Error(`Framework UI not ready: ${label}`);
}
const evaluate = (expression) => mainWindow.webContents.executeJavaScript(expression);
const status = () => evaluate('window.voice.status()');
function visibleMarker(png) {
  const image = nativeImage.createFromBuffer(png), pixels = image.toBitmap();
  const { width, height } = image.getSize();
  return fiveMarkersVisible(pixels, width, height);
}
async function click(selector) {
  const point = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element || element.disabled) throw new Error('Control unavailable.');
    element.scrollIntoView({block:'center'});
    const rect = element.getBoundingClientRect();
    return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)};
  })()`);
  mainWindow.focus();
  mainWindow.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', ...point, clickCount: 1 });
  mainWindow.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', ...point, clickCount: 1 });
}
async function record(finalText) {
  const before = service.bytes();
  await click('#toggle');
  await until(async () => {
    const current = await status();
    if (current.phase === 'error') throw new Error(current.message);
    return current.phase === 'recording' && service.bytes() > before;
  }, 'recording and PCM');
  assert.equal(await evaluate("document.getElementById('save-preferences').disabled"), true);
  await click('#toggle');
  await until(async () => {
    const current = await status();
    if (current.phase === 'error') throw new Error(current.message);
    return current.phase === 'done' && current.text === finalText;
  }, 'final result');
  await until(() => evaluate('capture === undefined'), 'microphone release');
}
async function run() {
  assert.equal(process.arch, process.env.VI_EXPECTED_ARCH);
  const provider = path.resolve(process.env.VI_PROVIDER_DIR);
  service = await require(path.join(provider, 'fixtures', 'provider-service.cjs')).createService();
  const fixture = path.join(directory, 'fixture-provider');
  await fs.mkdir(fixture, { recursive: true });
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(fixture, 'plugin.json'), JSON.stringify({
    id: 'fixture.service', kind: 'service-provider', apiVersion: 1, entry: 'index.cjs',
  }));
  await fs.writeFile(path.join(fixture, 'config.json'), JSON.stringify({ endpoint: service.endpoint }));
  await fs.writeFile(path.join(fixture, 'index.cjs'),
    `exports.createSession = options => require(${JSON.stringify(path.join(provider, 'src', 'providers', 'index.cjs'))})` +
    `.createSession({...options, credentialSource: async () => ({token:'fixture-credential'})});\n`);
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({
    consent: false, sounds: false, openAtLogin: false, autoCopy: false,
    shortcut: 'CommandOrControl+Alt+Shift+F9', cancelShortcut: 'CommandOrControl+Alt+Shift+F10',
  }));
  require('../app/main.cjs');
  await app.whenReady();
  await until(async () => {
    mainWindow = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().endsWith('/index.html'));
    if (!mainWindow) return false;
    const current = await status();
    if (current.phase === 'error') throw new Error(current.message);
    return current.shortcutReady && mainWindow.isVisible();
  }, 'native startup', 35000);
  await evaluate(`(() => {
    for (const position of ['left:4px;top:4px','right:4px;top:4px',
      'left:4px;bottom:4px','right:4px;bottom:4px','left:50%;top:50%']) {
      const marker = document.createElement('div');
      marker.style.cssText = 'position:fixed;width:24px;height:24px;background:#ff00ff;z-index:2147483647;pointer-events:none;' + position;
      document.body.append(marker);
    }
  })()`);
  const workArea = screen.getPrimaryDisplay().workArea;
  mainWindow.setBounds({ x: workArea.x + 10, y: workArea.y + 10,
    width: Math.min(720, workArea.width - 20), height: Math.min(800, workArea.height - 20) });
  mainWindow.setAlwaysOnTop(true);
  mainWindow.show();
  mainWindow.moveTop();
  let requireVisible = false;
  stopVideo = await recordDesktop(directory, (png) => {
    if (requireVisible) assert.ok(visibleMarker(png), 'Application was obscured in desktop video.');
  });
  await until(async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'],
      thumbnailSize: { width: 1280, height: 720 } });
    return sources[0] && visibleMarker(sources[0].thumbnail.toPNG());
  }, 'application visible on desktop');
  requireVisible = true;
  report.checks.push('application-visible-in-desktop-video');
  report.checks.push('full-framework-startup');
  assert.equal(await evaluate("document.getElementById('toggle').disabled"), true);
  await click('#consent');
  await until(async () => (await status()).consent, 'consent');
  report.checks.push('consent-controls-recording');
  await click('#test-mic');
  await until(() => evaluate("Number(document.getElementById('mic-level').value)>0"), 'local microphone meter');
  assert.equal(service.bytes(), 0);
  await click('#test-mic');
  await until(async () => !(await status()).testingMic && await evaluate('micTest === undefined'), 'microphone-test release');
  report.checks.push('microphone-test-without-network');
  await record('Fixture final text');
  await click('#copy');
  await until(async () => (await clipboard.readText()) === 'Fixture final text', 'copy result');
  report.checks.push('record-stop-final', 'manual-copy', 'microphone-release');
  const beforeCancel = await clipboard.readText();
  await click('#toggle');
  await until(async () => (await status()).phase === 'recording', 'cancel recording');
  await click('#cancel');
  await until(async () => (await status()).phase === 'idle' && await evaluate('capture === undefined'), 'cancel release');
  assert.equal(await clipboard.readText(), beforeCancel);
  report.checks.push('cancel-preserves-clipboard');
  await click('#auto-copy');
  await evaluate("document.getElementById('trigger-mode').value='push-to-talk'");
  await click('#save-preferences');
  await until(async () => {
    const current = await status();
    return current.autoCopy && current.triggerMode === 'push-to-talk';
  }, 'saved preferences');
  const saved = JSON.parse(await fs.readFile(path.join(profile, 'settings.json')));
  assert.equal(saved.triggerMode, 'push-to-talk');
  assert.equal(saved.autoCopy, true);
  await record('Fixture final text');
  assert.equal(await clipboard.readText(), 'Fixture final text');
  report.checks.push('preferences-persisted', 'automatic-final-copy');
  const config = path.join(profile, 'plugins', 'local.technical-vocabulary', 'config.json');
  await fs.writeFile(config, JSON.stringify({ scope: 'developer',
    rules: [{ alias: 'Fixture final text', target: 'UI processed text' }] }));
  await click('#plugin-list input');
  await until(async () => (await status()).pluginCount === 1 && !(await status()).pluginChanging, 'plugin enabled');
  await record('UI processed text');
  assert.equal(await clipboard.readText(), 'UI processed text');
  await click('#show-original');
  await until(() => evaluate("!document.getElementById('original-result').hidden && document.getElementById('original-result').value==='Fixture final text'"), 'original comparison');
  await click('#plugin-list input');
  await until(async () => (await status()).pluginCount === 0 && !(await status()).pluginChanging, 'plugin disabled');
  assert.equal((await status()).canCopy, false);
  report.checks.push('plugin-transform', 'original-comparison', 'plugin-disable-clears-result');
  await pause(1000);
  report.audioBytes = service.bytes();
  report.status = 'passed';
}
run().catch((error) => {
  report.status = 'failed'; report.error = error.message; process.exitCode = 1;
}).finally(async () => {
  try {
    if (stopVideo) Object.assign(report, await stopVideo());
    await service?.close();
  } catch (error) {
    report.status = 'failed'; report.evidenceError = error.message; process.exitCode = 1;
  }
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  if (process.exitCode) app.exit(1);
  else app.quit();
});
