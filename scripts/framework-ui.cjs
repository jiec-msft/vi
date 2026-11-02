const { app, BrowserWindow, clipboard, systemPreferences, nativeImage, desktopCapturer, screen } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { recordDesktop } = require('./desktop-evidence.cjs');
const { fiveMarkersVisible } = require('./visible-markers.cjs');
const { DesktopInput } = require('../app/desktop.cjs');

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
if (process.platform === 'win32') app.commandLine.appendSwitch('force-renderer-accessibility');
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
async function overlayPixels(overlay, display) {
  const sources = await desktopCapturer.getSources({ types: ['screen'],
    thumbnailSize: { width: display.bounds.width, height: display.bounds.height } });
  const source = sources.find((item) => item.display_id === String(display.id)) ||
    (sources.length === 1 ? sources[0] : undefined);
  if (!source) throw new Error('Owned overlay primary desktop capture is unavailable.');
  const image = source.thumbnail, size = image.getSize(), data = image.toBitmap();
  const bounds = overlay.getBounds();
  let dark = 0, light = 0, red = 0, sampled = 0;
  for (let y = bounds.y + 3; y < bounds.y + bounds.height - 3; y++) {
    for (let x = bounds.x + 3; x < bounds.x + bounds.width - 3; x++) {
      const px = Math.floor((x - display.bounds.x) * size.width / display.bounds.width);
      const py = Math.floor((y - display.bounds.y) * size.height / display.bounds.height);
      if (px < 0 || py < 0 || px >= size.width || py >= size.height) continue;
      const index = (py * size.width + px) * 4;
      const b = data[index], g = data[index + 1], r = data[index + 2];
      sampled++;
      if (r > 200 && g < 60 && b > 20 && b < 90) red++;
      if (r < 70 && g < 80 && b < 100) dark++;
      if (r > 120 && g > 120 && b > 120) light++;
    }
  }
  return { dark, light, red, sampled, bounds, painted: dark > 100 && light > 10 };
}
async function confirmOwnedFocus(driver, phase) {
  report.stage = phase;
  await until(async () => BrowserWindow.getFocusedWindow() === mainWindow &&
    !mainWindow.webContents.isLoading() && await evaluate('document.hasFocus()'), phase, 5000);
  const actual = await driver.capture();
  assert.equal(actual.pid, process.pid, `${phase}: foreground must belong to this CI process.`);
  assert.equal(actual.window, mainWindow.getNativeWindowHandle().readBigUInt64LE().toString(),
    `${phase}: native foreground must remain the owned settings HWND.`);
  (report.focusChecks ||= []).push({ phase, ownerVerified: true, nativeForegroundVerified: true });
}
async function verifyWindowsOverlay(driver) {
  if (process.platform !== 'win32') return;
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  mainWindow.focus();
  await confirmOwnedFocus(driver, 'overlay-owned-foreground-baseline');
  const overlay = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().endsWith('/overlay.html'));
  assert.ok(overlay);
  const display = screen.getPrimaryDisplay(), area = display.workArea;
  const bounds = { x: area.x + area.width - 230, y: area.y + 70, width: 224, height: 54 };
  const underlay = new BrowserWindow({ ...bounds, show: false, frame: false, focusable: false,
    alwaysOnTop: true, backgroundColor: '#ee1234', skipTaskbar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await underlay.loadURL('data:text/html,<body style="margin:0;background:rgb(238,18,52)">');
    underlay.showInactive();
    overlay.setBounds(bounds);
    overlay.moveTop();
    report.stage = 'overlay-physical-paint';
    await until(async () => (await overlayPixels(overlay, display)).painted, 'actual floating controls desktop pixels');
    const before = await overlayPixels(overlay, display);
    overlay.setBounds({ x: area.x + area.width + 500, y: area.y + area.height + 500, width: 240, height: 80 });
    screen.emit('display-metrics-changed', {}, display, ['workArea', 'scaleFactor']);
    underlay.setBounds(overlay.getBounds());
    await until(async () => {
      const current = overlay.getBounds();
      return current.width === 224 && current.height === 54 && (await overlayPixels(overlay, display)).painted;
    }, 'display-notification bounds and desktop pixel recovery');
    await confirmOwnedFocus(driver, 'overlay-bounds-nonactivation');
    assert.notEqual(overlay.webContents.getOSProcessId(), mainWindow.webContents.getOSProcessId(),
      'Renderer-crash fixture must not share the settings/audio renderer.');
    let loadedAgain = false;
    overlay.webContents.once('did-finish-load', () => { loadedAgain = true; });
    overlay.webContents.forcefullyCrashRenderer();
    await until(async () => loadedAgain && !overlay.webContents.isLoading() && (await overlayPixels(overlay, display)).painted,
      'isolated floating renderer recovery and actual desktop pixels');
    await confirmOwnedFocus(driver, 'overlay-renderer-recovery-nonactivation');
    await overlay.webContents.executeJavaScript('window.floatingVoice.cancel()');
    await until(() => !overlay.isVisible(), 'explicit floating hide');
    screen.emit('display-metrics-changed', {}, display, ['workArea']);
    assert.equal(overlay.isVisible(), false, 'Display recovery undid an intentional hide.');
    let hiddenPixels;
    await until(async () => {
      hiddenPixels = await overlayPixels(overlay, display);
      return !hiddenPixels.painted && hiddenPixels.sampled > 100 &&
        hiddenPixels.red / hiddenPixels.sampled > 0.9;
    }, 'physical negative: same rectangle contains the owned red underlay, not the widget');
    await evaluate('window.voice.showFloating()');
    await until(async () => (await overlayPixels(overlay, display)).painted, 'explicit floating show and painted controls');
    report.overlaySurface = { before, hidden: hiddenPixels, after: await overlayPixels(overlay, display),
      scope: 'CI-owned Windows desktop capture; synthetic display notification and isolated renderer failure',
      actualHardwareDpiTransitionTested: false };
    report.checks.push('floating-controls-native-desktop-pixels', 'floating-bounds-recovery', 'floating-renderer-recovery-no-focus');
  } finally { underlay.destroy(); }
}
async function verifyWindowsPaste(driver) {
  if (process.platform !== 'win32') return;
  report.stage = 'owned-native-caret-paste';
  const area = screen.getPrimaryDisplay().workArea;
  const editor = new BrowserWindow({ x: area.x + area.width - 420, y: area.y + 100, width: 400, height: 240,
    title: 'VI synthetic paste fixture', alwaysOnTop: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await editor.loadURL('data:text/html,<textarea aria-label="Owned synthetic text" style="width:95%;height:90%"></textarea>');
    editor.show(); editor.focus();
    await editor.webContents.executeJavaScript(`(() => {
      const field=document.querySelector('textarea');field.value='Prefix  Suffix';field.focus();field.setSelectionRange(7,7);
    })()`);
    await clipboard.writeText('Owned previous clipboard');
    assert.equal(await clipboard.readText(), 'Owned previous clipboard');
    await driver.warmup();
    await until(async () => BrowserWindow.getFocusedWindow() === editor &&
      await editor.webContents.executeJavaScript("document.hasFocus() && document.activeElement.tagName === 'TEXTAREA'"),
    'owned editor renderer and focus readiness', 5000);
    const target = await driver.capture();
    assert.equal(target.pid, process.pid, 'Only the CI-owned editor may receive this paste.');
    assert.equal(target.window, editor.getNativeWindowHandle().readBigUInt64LE().toString(),
      'Native target must match the CI-owned editor HWND.');
    assert.equal(await driver.paste('Approved final fixture', target), true);
    await until(async () => await editor.webContents.executeJavaScript("document.querySelector('textarea').value") ===
      'Prefix Approved final fixture Suffix', 'one approved caret paste without replacing surrounding text');
    assert.equal(await clipboard.readText(), 'Owned previous clipboard');
    report.checks.push('actual-native-approved-caret-paste-once', 'actual-native-clipboard-restored');
  } finally { editor.destroy(); }
}
async function verifyFloatingDomControls() {
  if (process.platform !== 'win32') return;
  const overlay = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().endsWith('/overlay.html'));
  for (const [button, outcome] of [['stop', 'done'], ['cancel', 'idle']]) {
    await click('#toggle');
    await until(async () => (await status()).phase === 'recording', 'owned recording for floating DOM control');
    const point = await overlay.webContents.executeJavaScript(`(() => {
      const r=document.getElementById(${JSON.stringify(button)}).getBoundingClientRect();
      return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
    })()`);
    // Renderer input intentionally has no corresponding GetAsyncKeyState polling gesture.
    overlay.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    overlay.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    overlay.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await until(async () => (await status()).phase === outcome, 'floating DOM-only quick gesture');
    await overlay.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    assert.equal((await status()).phase, outcome, 'A duplicate floating action restarted recording.');
  }
  report.checks.push('floating-dom-only-stop-cancel-no-polling-dependency');
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
  const nativeProbe = process.platform === 'win32' ? new DesktopInput() : undefined;
  try {
    await verifyWindowsOverlay(nativeProbe);
    await verifyWindowsPaste(nativeProbe);
  } finally { nativeProbe?.close(); }
  await click('#test-mic');
  await until(() => evaluate("Number(document.getElementById('mic-level').value)>0"), 'local microphone meter');
  assert.equal(service.bytes(), 0);
  await click('#test-mic');
  await until(async () => !(await status()).testingMic && await evaluate('micTest === undefined'), 'microphone-test release');
  report.checks.push('microphone-test-without-network');
  await verifyFloatingDomControls();
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
