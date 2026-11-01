const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const childProcess = require('node:child_process');
const { hostedGuard } = require('./windows-ci-desktop-probe.cjs');
hostedGuard();
const { app, BrowserWindow, nativeImage, desktopCapturer } = require('electron');
const { recordDesktop } = require('./desktop-evidence.cjs');
const { fiveMarkersVisible } = require('./visible-markers.cjs');
const directory = path.resolve('artifacts-ci', 'caret');
const profile = path.join(directory, 'profile');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { head: process.env.VI_PROBE_HEAD, runId: process.env.GITHUB_RUN_ID,
  attempt: process.env.GITHUB_RUN_ATTEMPT, platform: process.platform, arch: process.arch,
  scope: 'Actual application with an owned native synthetic editor; not user-device acceptance',
  checks: [], samples: [], helpers: [], limitations: ['UIA-only editors unsupported', 'No second hosted monitor or real secure desktop'] };
let editor, service, mainWindow, stopVideo;
const children = [];
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = spawn(...args);
  children.push(child);
  if (args[1]?.some((arg) => typeof arg === 'string' && arg.endsWith('windows-caret.ps1'))) {
    const record = { pid: child.pid, spawnedAt: Date.now() };
    report.helpers.push(record);
    child.once('exit', (code) => { record.exit = code; record.exitedAt = Date.now(); });
  }
  return child;
};
const { NativeDelivery } = require('../app/native-delivery.cjs');
app.commandLine.appendSwitch('user-data-dir', profile);
app.commandLine.appendSwitch('provider-dir', path.join(directory, 'fixture-provider'));
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', path.join(directory, 'input.wav'));
app.commandLine.appendSwitch('force-color-profile', 'srgb');
const evaluate = (expression) => mainWindow.webContents.executeJavaScript(expression);
const status = () => evaluate('window.voice.status()');
async function until(action, label, limit = 20000) {
  const deadline = Date.now() + limit;
  do {
    const value = await action();
    if (value) return value;
    await pause(60);
  } while (Date.now() < deadline);
  throw new Error(`Caret fixture deadline: ${label}`);
}
async function inspect(label) {
  const value = await editor.request('inspect', { helper: report.helpers.at(-1)?.pid || 0 });
  report.samples.push({ label, at: Date.now(), ...value });
  return value;
}
async function begin(field = 0) {
  report.stage = `begin-field-${field}`;
  await editor.request('click', { field });
  await editor.request('shortcut', { cancel: false });
  await until(async () => {
    const value = await status();
    if (value.phase === 'error') throw new Error(value.message);
    return value.phase === 'recording';
  }, 'actual shortcut recording');
}
async function visible() {
  await until(async () => {
    const value = await status();
    if (value.caretIndicatorState !== 'visible' && !['hidden', 'disabled'].includes(value.caretIndicatorState)) {
      throw new Error(`Native caret blocked: ${value.caretIndicatorState}`);
    }
    return value.caretIndicatorState === 'visible';
  }, 'native caret marker');
  const sample = await inspect('visible');
  assert.equal(sample.markers.length, 2);
  assert.equal(sample.foregroundPid, report.editor.pid);
  assert.equal(sample.focus, report.editor.focus);
  for (const marker of sample.markers) {
    assert.equal(marker.owner, report.editor.window);
    assert.equal(marker.styles & 0x080800a8, 0x080800a8);
  }
  const line = sample.markers.find(({ rect }) => rect.width < 20);
  assert.ok(line.rect.x > sample.caret.x);
  assert.equal(line.rect.y, sample.caret.y);
  assert.equal(line.rect.height, sample.caret.height);
  return sample;
}
async function cancel() {
  await editor.request('shortcut', { cancel: true });
  await until(async () => (await status()).phase === 'idle', 'cancel');
  await until(async () => (await inspect('hidden')).markers.length === 0, 'native marker destruction');
}
async function run() {
  await fs.mkdir(profile, { recursive: true });
  const wav = Buffer.alloc(44 + 32000);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40);
  for (let i = 0; i < 16000; i++) wav.writeInt16LE(Math.round(Math.sin(i * Math.PI * 220 / 8000) * 3000), 44 + i * 2);
  await fs.writeFile(path.join(directory, 'input.wav'), wav);
  const provider = path.resolve(process.env.VI_PROVIDER_DIR);
  service = await require(path.join(provider, 'fixtures', 'provider-service.cjs')).createService();
  const fixture = path.join(directory, 'fixture-provider');
  await fs.mkdir(fixture, { recursive: true });
  await fs.writeFile(path.join(fixture, 'plugin.json'), JSON.stringify({
    id: 'fixture.service', kind: 'service-provider', apiVersion: 1, entry: 'index.cjs',
  }));
  await fs.writeFile(path.join(fixture, 'config.json'), JSON.stringify({ endpoint: service.endpoint }));
  await fs.writeFile(path.join(fixture, 'index.cjs'),
    `exports.createSession = options => require(${JSON.stringify(path.join(provider, 'src', 'providers', 'index.cjs'))})` +
    `.createSession({...options, credentialSource: async () => ({token:'fixture-credential'})});\n`);
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({
    consent: true, sounds: false, openAtLogin: false, caretIndicator: true,
    shortcut: 'Control+Alt+Shift+F9', cancelShortcut: 'Control+Alt+Shift+F10',
  }));
  require('../app/main.cjs');
  await app.whenReady();
  await until(async () => {
    mainWindow = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/index.html'));
    return mainWindow && (await status()).shortcutReady;
  }, 'actual application startup', 40000);
  assert.equal(await evaluate("document.getElementById('caret-indicator').checked"), true);
  report.checks.push('actual-app-settings-opt-in');
  mainWindow.hide();
  editor = new NativeDelivery('win32', __dirname, 'windows-caret-fixture.ps1');
  editor.process.stderr.on('data', (bytes) => {
    const value = bytes.toString();
    report.fixtureDiagnostics = ((report.fixtureDiagnostics || '') + value).slice(-8192);
    console.error(value);
  });
  report.editor = await editor.request('ready');
  assert.equal(report.editor.owned, true);
  assert.equal(report.editor.desktop, 'Default');
  const ownedFrame = (png) => {
    const image = nativeImage.createFromBuffer(png);
    const { width, height } = image.getSize();
    return fiveMarkersVisible(image.toBitmap(), width, height);
  };
  await until(async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } });
    return sources[0] && ownedFrame(sources[0].thumbnail.toPNG());
  }, 'owned editor covers the actual desktop');
  stopVideo = await recordDesktop(directory, (png) => {
    assert.ok(ownedFrame(png), 'Owned editor was obscured in the actual desktop recording.');
    report.frames = (report.frames || 0) + 1;
  });
  await begin();
  const initial = await visible();
  report.checks.push('actual-app-shortcut-recording', 'physical-caret-geometry', 'native-owned-window-flags', 'foreground-unchanged');
  await pause(800);
  await editor.request('move');
  await pause(250);
  const moved = await visible();
  assert.notEqual(moved.caret.x, initial.caret.x);
  report.checks.push('actual-caret-movement');
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
  assert.ok(sources[0] && !sources[0].thumbnail.isEmpty());
  await fs.writeFile(path.join(directory, 'caret-visible.png'), sources[0].thumbnail.toPNG());
  const image = nativeImage.createFromBuffer(sources[0].thumbnail.toPNG());
  assert.ok(image.getSize().width > 0);
  const passed = await editor.request('pass-through', { helper: report.helpers.at(-1).pid });
  assert.equal(passed.after, passed.before + 1);
  assert.equal(passed.editorFocused, true);
  assert.equal(passed.foregroundPid, report.editor.pid);
  report.checks.push('real-os-click-through-marker');
  await editor.request('shortcut', { cancel: false });
  await until(async () => (await status()).phase === 'done', 'final-only paste', 20000);
  const final = await inspect('final');
  assert.equal(final.text.includes('Fixture final text'), true);
  assert.equal(final.markers.length, 0);
  report.checks.push('actual-final-only-paste', 'completion-hides-marker');
  await begin();
  await visible();
  await editor.request('click', { field: 1 });
  await until(async () => (await status()).caretIndicatorState === 'target-changed', 'focus invalidation');
  await editor.request('click', { field: 0 });
  await pause(350);
  assert.equal((await inspect('focus-return')).markers.length, 0);
  await editor.request('shortcut', { cancel: false });
  await until(async () => (await status()).phase === 'done', 'invalid lease finalization');
  assert.equal((await status()).insertionResult, 'preview');
  assert.equal((await inspect('invalid-lease')).text, final.text);
  report.checks.push('focus-change-invalidates-final-lease', 'focus-return-cannot-resurrect');
  await begin();
  await visible();
  await editor.request('selection');
  await until(async () => (await status()).caretIndicatorState === 'no-input', 'selection hides');
  await cancel();
  report.checks.push('selection-remains-unchanged', 'cancel-destroys-marker');
  await editor.request('click', { field: 2 });
  await editor.request('shortcut', { cancel: false });
  await until(async () => (await status()).phase === 'error', 'password capture is refused');
  assert.equal((await inspect('password')).markers.length, 0);
  report.checks.push('password-fail-closed');
  await pause(500);
  assert.ok(report.helpers.every((helper) => helper.exitedAt), 'Caret helpers did not exit.');
  report.checks.push('helper-cleanup');
}
run().then(async () => {
  report.passed = true;
  await cleanup();
  app.quit();
}, async (error) => {
  report.passed = false;
  report.error = error.message;
  console.error(error);
  await cleanup();
  app.exit(1);
});
async function cleanup() {
  if (stopVideo) {
    report.media = await stopVideo();
    stopVideo = undefined;
  }
  editor?.close();
  await service?.close();
  for (const child of children) if (child.exitCode === null) child.kill();
  await fs.writeFile(path.join(directory, 'caret-report.json'), JSON.stringify(report, null, 2));
}
