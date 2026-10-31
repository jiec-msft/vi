const { app, BrowserWindow, clipboard, systemPreferences, nativeImage, screen } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { promisify } = require('node:util');
const { recordDesktop } = require('./desktop-evidence.cjs');

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.VI_OUTPUT ||
    !process.env.VI_PROVIDER_DIR || !process.argv.includes('--ci-mode=overlay-recovery')) {
  throw new Error('Overlay UI checks require the isolated CI launcher.');
}
const directory = path.resolve(process.env.VI_OUTPUT), profile = path.join(directory, 'profile');
const unavailable = path.join(directory, 'cursor-unavailable');
app.commandLine.appendSwitch('user-data-dir', profile);
app.commandLine.appendSwitch('provider-dir', path.join(directory, 'fixture-provider'));
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', path.join(directory, 'input.wav'));
app.commandLine.appendSwitch('force-color-profile', 'srgb');
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('disable-features', 'AudioServiceSandbox');
  systemPreferences.askForMediaAccess = async (kind) => kind === 'microphone';
}
const report = { platform: process.platform, arch: process.arch, checks: [], helperPids: [],
  mouseScope: 'OS mouse input to owned app window only',
  cursorFailureScope: 'Windows native sampler seam; not a real desktop/RDP transition',
  controlScope: 'physical Stop/Cancel on preview recordings; Ready Start requires an external input target and is not asserted',
  microphoneScope: 'synthetic-input; no service credentials' };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const execFile = promisify(childProcess.execFile);
const helpers = [];
let mainWindow, overlay, service, stopVideo, held = false;
let shows = 0, hides = 0, focusChanges = 0;
let stage = 'startup';
report.windowEvents = [];
async function until(action, label, limit = 15000) {
  const deadline = Date.now() + limit;
  do {
    if (await action()) return;
    await pause(50);
  } while (Date.now() < deadline);
  throw new Error(`Overlay evidence deadline: ${label}`);
}
const evaluate = (expression) => mainWindow.webContents.executeJavaScript(expression);
const status = () => evaluate('window.voice.status()');
async function mouse(mode, point) {
  const location = process.platform === 'win32' ? screen.dipToScreenPoint(point) : point;
  if (process.platform === 'win32') {
    const handle = overlay.getNativeWindowHandle();
    const id = handle.readBigUInt64LE().toString();
    await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.resolve('test', 'framework', 'fixtures', 'overlay-mouse.ps1'),
      '-Window', id, '-Owner', String(process.pid), '-Mode', mode, '-X', String(location.x), '-Y', String(location.y)],
    { timeout: 15000, windowsHide: true });
  } else {
    await execFile(path.resolve('test', 'framework', 'fixtures', 'overlay-mouse'),
      [String(process.pid), mode, String(location.x), String(location.y)], { timeout: 10000 });
  }
  if (mode === 'down') held = true;
  if (mode === 'up') held = false;
  assert.equal(BrowserWindow.getFocusedWindow(), mainWindow, 'Floating overlay stole application focus.');
  assert.equal(overlay.isVisible(), true, 'Floating overlay disappeared during OS input.');
}
async function pointFor(selector) {
  const point = await overlay.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)};
  })()`);
  const bounds = overlay.getBounds();
  return { x: bounds.x + point.x, y: bounds.y + point.y };
}
async function physicalDrag(label) {
  stage = label;
  const before = overlay.getBounds(), point = await pointFor('#drag-handle');
  await mouse('hover', point);
  await pause(200);
  await mouse('down', point);
  await mouse('move', { x: point.x - 10, y: point.y - 6 });
  const target = { x: point.x - 70, y: point.y - 46 };
  await mouse('move', target);
  await until(() => overlay.getBounds().x <= before.x - 40 && overlay.getBounds().y <= before.y - 20, label);
  await mouse('up', target);
  await until(async () => {
    const saved = JSON.parse(await fs.readFile(path.join(profile, 'settings.json')));
    const bounds = overlay.getBounds();
    return saved.overlay?.x === bounds.x && saved.overlay?.y === bounds.y;
  }, 'completed drag persisted');
  report.checks.push(label);
  report[label] = { before, after: overlay.getBounds(), input: process.platform === 'win32' ? 'Win32' : 'CGEvent' };
  await fs.writeFile(path.join(directory, `${label}.png`), (await overlay.webContents.capturePage()).toPNG());
}
async function physicalControls(label) {
  stage = label;
  const changes = { shows, hides, focusChanges };
  const bytes = service.bytes();
  await evaluate('window.voice.toggle()');
  await until(async () => (await status()).phase === 'recording' && service.bytes() > bytes, 'recording before Stop');
  await mouse('click', await pointFor('#stop'));
  await until(async () => (await status()).phase === 'done', 'physical Stop finalization');
  await pause(1200);
  assert.equal((await status()).phase, 'done', 'Duplicate Stop started another recording.');
  await evaluate('window.voice.toggle()');
  await until(async () => (await status()).phase === 'recording', 'recording before physical Cancel');
  const before = await clipboard.readText();
  await mouse('click', await pointFor('#cancel'));
  await until(async () => (await status()).phase === 'idle' && await evaluate('capture === undefined'), 'physical Cancel');
  assert.equal(await clipboard.readText(), before);
  assert.deepEqual({ shows, hides, focusChanges }, changes, 'Ready/Listening controls flashed or activated the overlay.');
  report.checks.push(label, `${label}-no-hide-show-or-focus-change`);
}
function markerVisible(png) {
  const image = nativeImage.createFromBuffer(png), pixels = image.toBitmap();
  let count = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset] > 180 && pixels[offset + 1] < 80 && pixels[offset + 2] > 180) count++;
  }
  return count >= 8;
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
    consent: true, sounds: false, openAtLogin: false, autoCopy: false,
    shortcut: 'CommandOrControl+Alt+Shift+F9', cancelShortcut: 'CommandOrControl+Alt+Shift+F10',
  }));
  if (process.platform === 'win32') {
    const original = await fs.readFile(path.resolve('native', 'windows-overlay.ps1'), 'utf8');
    const seam = `
    static bool ReadCursor(out POINT point) {
        point = new POINT();
        return !System.IO.File.Exists(${JSON.stringify(unavailable)}) && GetCursorPos(out point);
    }
`;
    assert.ok(original.includes('if (!GetCursorPos(out point))'));
    const injected = original.replace('    POINT last;', `    POINT last;${seam}`)
      .replace('if (!GetCursorPos(out point))', 'if (!ReadCursor(out point))');
    const helperFile = path.join(directory, 'windows-overlay-ci.ps1');
    await fs.writeFile(helperFile, injected);
    const spawn = childProcess.spawn;
    childProcess.spawn = (file, args, options) => {
      const pointer = args?.some((arg) => typeof arg === 'string' && arg.endsWith('windows-overlay.ps1'));
      const actual = pointer ? args.map((arg) => arg.endsWith('windows-overlay.ps1') ? helperFile : arg) : args;
      const child = spawn(file, actual, options);
      if (pointer) {
        helpers.push(child);
        report.helperPids.push(child.pid);
      }
      return child;
    };
  }
  require('../app/main.cjs');
  await app.whenReady();
  await until(async () => {
    mainWindow = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/index.html'));
    overlay = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/overlay.html'));
    return mainWindow && overlay && overlay.isVisible() && (await status()).shortcutReady &&
      (process.platform !== 'win32' || (await status()).nativePointer);
  }, 'full application and native pointer startup', 35000);
  mainWindow.focus();
  await until(() => BrowserWindow.getFocusedWindow() === mainWindow, 'owned focus baseline');
  assert.equal(overlay.isFocusable(), false);
  const windowEvent = (event) => report.windowEvents.push({ event, stage, at: Date.now(), visible: overlay.isVisible() });
  overlay.on('show', () => { shows++; windowEvent('show'); });
  overlay.on('hide', () => { hides++; windowEvent('hide'); });
  overlay.on('focus', () => { focusChanges++; windowEvent('focus'); });
  await overlay.webContents.executeJavaScript(`(() => {
    const marker = document.createElement('div');
    marker.style.cssText = 'position:fixed;right:4px;bottom:4px;width:14px;height:14px;background:#ff00ff;pointer-events:none;z-index:2147483647';
    document.body.append(marker);
  })()`);
  stopVideo = await recordDesktop(directory, (png) => assert.ok(markerVisible(png), 'Overlay obscured in desktop evidence.'));
  await pause(500);
  report.startupVisibilityEvents = { shows, hides, focusChanges };
  assert.equal(hides, 0, 'Overlay disappeared while establishing the startup baseline.');
  shows = hides = focusChanges = 0;
  await physicalDrag('physical-drag');
  await physicalControls('physical-stop-cancel');
  if (process.platform === 'win32') {
    stage = 'native-cursor-suspension';
    let point = await pointFor('#drag-handle');
    await mouse('hover', point);
    await mouse('down', point);
    await mouse('move', { x: point.x - 20, y: point.y - 10 });
    await fs.writeFile(unavailable, 'cursor sampling unavailable');
    await until(async () => (await status()).nativePointerState === 'suspended', 'temporary cursor suspension');
    const suspended = overlay.getBounds(), helperCount = helpers.length;
    await fs.unlink(unavailable);
    await until(async () => (await status()).nativePointer, 'same helper resumed');
    await mouse('move', { x: point.x - 45, y: point.y - 25 });
    assert.deepEqual(overlay.getBounds(), suspended, 'Cancelled gesture resumed while the button remained held.');
    await mouse('up', { x: point.x - 45, y: point.y - 25 });
    assert.equal(helpers.length, helperCount, 'Temporary cursor failure restarted the helper.');
    report.checks.push('native-cursor-suspend-cancels-held-drag', 'native-cursor-resume-without-restart');
    await physicalDrag('physical-drag-after-cursor-resume');
    stage = 'owned-helper-death';
    point = await pointFor('#drag-handle');
    await mouse('hover', point);
    await mouse('down', point);
    helpers.at(-1).kill();
    await until(async () => !(await status()).nativePointer, 'helper death clears readiness');
    await until(async () => (await status()).nativePointer && helpers.length === 2, 'owned helper recovered');
    const recovered = overlay.getBounds();
    await mouse('move', { x: point.x - 30, y: point.y - 20 });
    assert.deepEqual(overlay.getBounds(), recovered, 'Dead helper gesture survived recovery.');
    await mouse('up', { x: point.x - 30, y: point.y - 20 });
    await physicalDrag('physical-drag-after-helper-recovery');
    report.checks.push('owned-helper-death-recovery-cancels-gesture');
    stage = 'native-retry-budget';
    for (let count = 2; count <= 4; count++) {
      helpers.at(-1).kill();
      if (count < 4) await until(async () => (await status()).nativePointer && helpers.length === count + 1, 'bounded retry');
      else await until(async () => (await status()).nativePointerState === 'unavailable', 'retry budget exhausted');
    }
    const exhausted = await status();
    assert.equal(exhausted.nativePointer, false);
    assert.equal(exhausted.nativePointerRestarts, 3);
    assert.match(exhausted.overlayControlError, /Restart the app/);
    await pause(3500);
    assert.equal(helpers.length, 4, 'Automatic restarts exceeded the lifetime budget.');
    report.checks.push('native-recovery-bounded-to-three-restarts');
    await physicalDrag('physical-drag-fallback-after-helper-death');
    await physicalControls('fallback-physical-stop-cancel');
  } else {
    report.checks.push('macOS-DOM-fallback-physical-input');
    report.cursorFailureScope = 'not applicable; Windows native helper only';
  }
  report.visibilityEvents = { shows, hides, focusChanges };
  assert.equal(shows, 0);
  assert.equal(hides, 0);
  assert.equal(focusChanges, 0);
  report.finalPointerState = (await status()).nativePointerState;
  report.status = 'passed';
}
run().catch((error) => {
  report.status = 'failed'; report.error = error.message; process.exitCode = 1;
  console.error(error.stack);
}).finally(async () => {
  try {
    if (held && overlay && !overlay.isDestroyed()) {
      await mouse('up', screen.getCursorScreenPoint());
    }
    if (stopVideo) Object.assign(report, await stopVideo());
    await service?.close();
  } catch (error) {
    report.status = 'failed'; report.cleanupError = error.message; process.exitCode = 1;
    console.error(error.stack);
  }
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  app.quit();
});
