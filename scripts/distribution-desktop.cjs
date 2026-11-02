const fs = require('node:fs');
const { FinalDesktopLifecycle, stages } = require('./distribution-desktop-lifecycle.cjs');
const { writeMixedClipboard, readMixedClipboard } = require('./distribution-clipboard.cjs');
const { acquireOwnedForeground } = require('./owned-foreground.cjs');
const report = { status: 'failed', scope: 'final-extracted-module/native-path on matching generic Electron host',
  appMainExercised: false, actualUserApplicationUsed: false, microphoneUsed: false, externalServiceCalled: false };
let driver, editor, timer, app;
let published = 0;
const lifecycle = new FinalDesktopLifecycle({
  report, driver: () => driver, editor: () => editor,
  publish(stage) {
    if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.VI_FIXTURE_PROGRESS ||
        !stages.has(stage) || ++published > 16) throw new Error('Invalid final desktop progress publication.');
    fs.appendFileSync(process.env.VI_FIXTURE_PROGRESS, `${JSON.stringify({ pid: process.pid, stage })}\n`);
  },
  output: (value) => console.log(JSON.stringify(value)),
  exit: (code) => { process.exitCode = code; app.exit(code); },
  clearDeadline: () => clearTimeout(timer),
});
function progress(stage) {
  if (!lifecycle.publish(stage)) throw lifecycle.failure();
}
lifecycle.publish('js-entry');
const electron = require('electron');
app = electron.app;
const { BrowserWindow, clipboard, ClipboardItem } = electron;
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
lifecycle.publish('imports-ready');
app.commandLine.appendSwitch('force-renderer-accessibility');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(action, label) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await action()) return; await pause(50); }
  throw new Error(`Final native delivery did not confirm ${label}.`);
}
async function run() {
  const publicationError = lifecycle.failure();
  if (publicationError) throw publicationError;
  const marker = process.argv.indexOf('--ci-final-native-delivery');
  if (process.env.GITHUB_ACTIONS !== 'true' || marker < 0 || !process.env.VI_FIXTURE_PROFILE) {
    throw new Error('Final native delivery fixtures require an isolated CI host.');
  }
  const resources = fs.realpathSync(process.argv[marker + 1]);
  const authority = JSON.parse(fs.readFileSync(process.argv[marker + 2], 'utf8'));
  const appRoot = path.join(resources, 'app');
  const nativeRoot = path.join(appRoot, 'native');
  assert.equal(app.commandLine.getSwitchValue('user-data-dir'), process.env.VI_FIXTURE_PROFILE,
    'The isolated browser profile must be selected before the final fixture enters JavaScript.');
  assert.equal(process.platform, 'win32');
  assert.equal(process.arch, authority.architecture);
  assert.equal(process.versions.electron, authority.electron);
  report.hostExecutableSha256 = createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex');
  assert.equal(report.hostExecutableSha256, authority.electronSourceExecutableSha256);
  progress('host-verified');
  report.nativeSources = {};
  for (const name of ['windows-delivery.ps1', 'windows-clipboard-snapshot.cs', 'windows-clipboard-errors.ps1', 'windows-input.ps1', 'windows-diagnostics.ps1', 'windows-bootstrap.ps1']) {
    const sha256 = createHash('sha256').update(fs.readFileSync(path.join(nativeRoot, name))).digest('hex');
    assert.equal(sha256, authority.sourceFiles[`native/${name}`].sha256);
    report.nativeSources[name] = sha256;
  }
  progress('sources-verified');
  const before = new Set(Object.keys(require.cache));
  const load = createRequire(path.join(appRoot, 'package.json'));
  const { DesktopInput } = load('./app/desktop.cjs');
  driver = new DesktopInput({ resources: nativeRoot });
  report.modules = Object.keys(require.cache).filter((file) => !before.has(file)).map((file) => {
    const relative = path.relative(appRoot, fs.realpathSync(file)).split(path.sep).join('/');
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative));
    const sha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.equal(sha256, authority.sourceFiles[relative].sha256);
    return { relative, sha256 };
  });
  progress('modules-loaded');
  await app.whenReady();
  assert.equal(fs.realpathSync(app.getPath('userData')), fs.realpathSync(process.env.VI_FIXTURE_PROFILE));
  progress('app-ready');
  editor = new BrowserWindow({ width: 500, height: 300, title: 'VI owned final delivery fixture',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await editor.loadURL('data:text/html,<textarea aria-label="Owned fixture" style="width:95%;height:90%"></textarea>');
  editor.show();
  await editor.webContents.executeJavaScript(`(() => {
    const field=document.querySelector('textarea');field.value='Prefix  Suffix';field.focus();field.setSelectionRange(7,7);
  })()`);
  progress('editor-ready');
  await writeMixedClipboard(clipboard, ClipboardItem);
  const original = await readMixedClipboard(clipboard);
  assert.equal(original.text.toString('utf8'), 'Owned original clipboard');
  assert.match(original.html.toString('utf8'), /<b>Owned original rich clipboard<\/b>/);
  await driver.warmup();
  report.actualFinalHelperReady = true;
  report.helperPid = driver.driver.process.pid;
  progress('helper-ready');
  report.focusAcquisition = { budgetMs: 5000, attempts: 0 };
  const target = await acquireOwnedForeground({ driver, window: editor, ownerPid: process.pid,
    rendererReady: async () => BrowserWindow.getFocusedWindow() === editor && !editor.webContents.isLoading() &&
      await editor.webContents.executeJavaScript("document.hasFocus() && document.activeElement.tagName === 'TEXTAREA'"),
    onAttempt: (value) => Object.assign(report.focusAcquisition, value) });
  assert.equal(target.pid, process.pid, 'Only the CI-owned editor may receive this paste.');
  assert.equal(target.window, editor.getNativeWindowHandle().readBigUInt64LE().toString(),
    'Native target must match the CI-owned final editor HWND.');
  progress('target-verified');
  assert.equal(await driver.paste('Approved final fixture', target), true);
  await until(async () => await editor.webContents.executeJavaScript("document.querySelector('textarea').value") ===
    'Prefix Approved final fixture Suffix', 'one caret paste with unchanged prefix/suffix');
  assert.deepEqual(await readMixedClipboard(clipboard), original);
  report.actualFinalTargetedPaste = true;
  report.actualMixedClipboardRestored = true;
  progress('paste-verified');
  report.status = 'passed';
}
timer = setTimeout(() => {
  try { lifecycle.deadline(); }
  catch { process.exitCode = 1; console.error('Final desktop deadline failed.'); }
}, 60000);
run().then(() => lifecycle.finish(), (error) => lifecycle.finish(error)).catch(() => {
  process.exitCode = 1;
  console.error('Final desktop operation, publication or cleanup failed.');
});
