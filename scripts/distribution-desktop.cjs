const { app, BrowserWindow, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const marker = process.argv.indexOf('--ci-final-native-delivery');
if (process.env.GITHUB_ACTIONS !== 'true' || marker < 0 || !process.env.VI_FIXTURE_PROFILE) {
  throw new Error('Final native delivery fixtures require an isolated CI host.');
}
const resources = fs.realpathSync(process.argv[marker + 1]);
const authority = JSON.parse(fs.readFileSync(process.argv[marker + 2], 'utf8'));
const appRoot = path.join(resources, 'app');
const nativeRoot = path.join(appRoot, 'native');
app.commandLine.appendSwitch('user-data-dir', process.env.VI_FIXTURE_PROFILE);
app.commandLine.appendSwitch('force-renderer-accessibility');
const report = { status: 'failed', scope: 'final-extracted-module/native-path on matching generic Electron host',
  appMainExercised: false, actualUserApplicationUsed: false, microphoneUsed: false, externalServiceCalled: false };
let driver, editor, timer;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(action, label) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await action()) return; await pause(50); }
  throw new Error(`Final native delivery did not confirm ${label}.`);
}
async function run() {
  assert.equal(process.platform, 'win32');
  assert.equal(process.arch, authority.architecture);
  assert.equal(process.versions.electron, authority.electron);
  report.hostExecutableSha256 = createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex');
  assert.equal(report.hostExecutableSha256, authority.electronSourceExecutableSha256);
  report.nativeSources = {};
  for (const name of ['windows-delivery.ps1', 'windows-clipboard-snapshot.cs', 'windows-input.ps1', 'windows-diagnostics.ps1']) {
    const sha256 = createHash('sha256').update(fs.readFileSync(path.join(nativeRoot, name))).digest('hex');
    assert.equal(sha256, authority.sourceFiles[`native/${name}`].sha256);
    report.nativeSources[name] = sha256;
  }
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
  await app.whenReady();
  editor = new BrowserWindow({ width: 500, height: 300, title: 'VI owned final delivery fixture',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await editor.loadURL('data:text/html,<textarea aria-label="Owned fixture" style="width:95%;height:90%"></textarea>');
  editor.show(); editor.focus();
  await editor.webContents.executeJavaScript(`(() => {
    const field=document.querySelector('textarea');field.value='Prefix  Suffix';field.focus();field.setSelectionRange(7,7);
  })()`);
  clipboard.write({ text: 'Owned original clipboard', html: '<b>Owned original rich clipboard</b>' });
  const original = { text: clipboard.readText(), html: clipboard.readHTML() };
  await driver.warmup();
  report.actualFinalHelperReady = true;
  report.helperPid = driver.driver.process.pid;
  const target = await driver.capture();
  assert.equal(target.pid, process.pid, 'Only the CI-owned editor may receive this paste.');
  assert.equal(await driver.paste('Approved final fixture', target), true);
  await until(async () => await editor.webContents.executeJavaScript("document.querySelector('textarea').value") ===
    'Prefix Approved final fixture Suffix', 'one caret paste with unchanged prefix/suffix');
  assert.deepEqual({ text: clipboard.readText(), html: clipboard.readHTML() }, original);
  report.actualFinalTargetedPaste = true;
  report.actualMixedClipboardRestored = true;
  report.status = 'passed';
}
timer = setTimeout(() => { driver?.close(); app.exit(1); }, 60000);
run().catch((error) => { report.error = error.message; process.exitCode = 1; }).finally(async () => {
  try {
    const child = driver?.driver?.process;
    const exited = child && child.exitCode === null && child.signalCode === null ? once(child, 'exit') : undefined;
    driver?.close();
    if (exited) await Promise.race([exited, pause(2500).then(() => { throw new Error('Owned final native helper did not exit.'); })]);
    report.helperExited = !child || child.exitCode !== null || child.signalCode !== null;
    editor?.destroy();
  } catch (error) { report.status = 'failed'; report.cleanupError = error.message; process.exitCode = 1; }
  clearTimeout(timer);
  console.log(JSON.stringify(report));
  app.exit(process.exitCode || (report.status === 'passed' ? 0 : 1));
});
