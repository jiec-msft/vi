const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { fileInventory } = require('../scripts/distribution-files.cjs');
const { distributionVersion, childEnv, electronDistribution, packagingShellContext,
  validatePackagingShell, probePackagingShell, finalDesktopLaunch, finalDesktopDiagnostics } = require('../scripts/distribution.cjs');

test('Windows packaging uses the native runner PowerShell family with an isolated module path', () => {
  const programFiles = path.resolve('synthetic-program-files');
  const supplied = { ProgramFiles: programFiles, PATH: 'synthetic-path',
    PSModulePath: 'synthetic-foreign-modules', PSMODULEPATH: 'another-foreign-path',
    NODE_OPTIONS: 'tool-parent-setting' };
  const original = { ...supplied };
  const context = packagingShellContext(supplied);
  const home = path.join(programFiles, 'PowerShell', '7');
  assert.equal(context.executable, path.join(home, 'pwsh.exe'));
  assert.equal(context.env.PSModulePath, path.join(home, 'Modules'));
  assert.deepEqual(Object.keys(context.env).filter((name) => name.toUpperCase() === 'PSMODULEPATH'), ['PSModulePath']);
  assert.equal(context.env.PATH, supplied.PATH);
  assert.deepEqual(supplied, original, 'The tool context changed its parent process environment.');
  assert.throws(() => packagingShellContext({}), /ProgramFiles/);
  assert.throws(() => packagingShellContext({ ProgramFiles: 'relative' }), /absolute/);
  const app = childEnv('synthetic-profile');
  assert.ok(!Object.keys(app).some((name) => name.toUpperCase() === 'PSMODULEPATH'));
});

test('binary cmdlets may live in the engine root while archive functions must retain their exact script origin', () => {
  const context = packagingShellContext({ ProgramFiles: path.resolve('synthetic-program-files') });
  const home = path.dirname(context.executable);
  const toolchain = { edition: 'Core', architecture: 'arm64', engineDirectory: home,
    securityCommand: 'Microsoft.PowerShell.Security', archiveCommand: 'Microsoft.PowerShell.Archive',
    securityModule: home, archiveModule: path.join(home, 'Modules', 'Microsoft.PowerShell.Archive'),
    securityAssembly: path.join(home, 'Microsoft.PowerShell.Security.dll'),
    archiveScript: path.join(home, 'Modules', 'Microsoft.PowerShell.Archive', 'Microsoft.PowerShell.Archive.psm1') };
  validatePackagingShell(toolchain, context, 'arm64');
  for (const change of [{ securityAssembly: path.join(home, 'other.dll') },
    { archiveScript: path.resolve('foreign.psm1') }, { engineDirectory: path.dirname(home) },
    { edition: 'Desktop' }, { architecture: 'x64' }]) {
    assert.throws(() => validatePackagingShell({ ...toolchain, ...change }, context, 'arm64'));
  }
});

test('Windows native packaging probe loads and validates the real selected cmdlet implementations', {
  skip: process.platform !== 'win32',
}, () => {
  const supplied = { ...process.env, PSModulePath: path.resolve('synthetic-foreign-modules') };
  const context = packagingShellContext(supplied);
  validatePackagingShell(probePackagingShell(supplied), context, process.arch);
});

test('Windows native packaging archive scripts preserve bytes through whitespace-safe file arguments', {
  skip: process.platform !== 'win32',
}, (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vi archive contract ')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = path.join(root, 'payload with spaces');
  fs.mkdirSync(path.join(payload, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'regular file.txt'), 'Synthetic archive content.');
  fs.writeFileSync(path.join(payload, '.metadata'), Buffer.from([0, 1, 255]));
  fs.writeFileSync(path.join(payload, 'nested', 'empty'), '');
  const zip = path.join(root, 'archive with spaces.zip');
  const extracted = path.join(root, 'fresh extraction');
  const context = packagingShellContext();
  const run = (args) => execFileSync(context.executable, ['-NoProfile', '-NonInteractive', '-File',
    path.resolve('scripts', 'distribution-archive.ps1'), ...args],
  { env: context.env, encoding: 'utf8', timeout: 15000 });
  const writer = JSON.parse(run(['-Root', payload, '-Zip', zip]));
  assert.equal(writer.files, 3);
  assert.equal(writer.uncompressedBytes, 29);
  assert.equal(writer.zip32Budget, 4026531840);
  assert.ok(writer.uncompressedBytes < writer.zip32Budget);
  run(['-Action', 'extract', '-Root', extracted, '-Zip', zip]);
  assert.deepEqual(fileInventory(extracted), fileInventory(payload));
  const bytes = fs.readFileSync(zip);
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
  assert.equal(bytes.readUInt16LE(bytes.length - 12), 3);
  assert.equal(bytes.subarray(30, 30 + bytes.readUInt16LE(26)).toString('utf8').startsWith('./'), false);
  assert.throws(() => run(['-Action', 'extract', '-Root', extracted, '-Zip', zip]), /new directory/);
  const emptyPayload = path.join(root, 'zero-byte payload');
  fs.mkdirSync(emptyPayload);
  fs.writeFileSync(path.join(emptyPayload, 'empty'), '');
  const emptyZip = path.join(root, 'zero-byte content.zip');
  const emptyExtracted = path.join(root, 'fresh zero-byte extraction');
  const emptyWriter = JSON.parse(run(['-Root', emptyPayload, '-Zip', emptyZip]));
  assert.deepEqual(emptyWriter, { files: 1, uncompressedBytes: 0, zip32Budget: 4026531840 });
  run(['-Action', 'extract', '-Root', emptyExtracted, '-Zip', emptyZip]);
  assert.deepEqual(fileInventory(emptyExtracted), fileInventory(emptyPayload));
  const noFiles = path.join(root, 'no files');
  fs.mkdirSync(noFiles);
  assert.throws(() => run(['-Root', noFiles, '-Zip', path.join(root, 'invalid.zip')]), /files=0, bytes=0, limit=4026531840/);
});

test('native distribution initializes the public Electron loader before reading its binary layout', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vi-electron-layout-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const platform of ['win32', 'darwin']) {
    const source = platform === 'win32' ? path.join(root, 'win-runtime') : path.join(root, 'Electron.app');
    const executable = platform === 'win32' ? path.join(source, 'electron.exe')
      : path.join(source, 'Contents', 'MacOS', 'Electron');
    let called = 0;
    const actual = electronDistribution(platform, () => {
      called++;
      fs.mkdirSync(path.dirname(executable), { recursive: true });
      fs.writeFileSync(executable, 'Non-executed runtime layout fixture.');
      return executable;
    });
    assert.equal(called, 1);
    assert.deepEqual(actual, { executable, source });
  }
  assert.throws(() => electronDistribution('win32', () => path.join(root, 'missing.exe')), /ENOENT/);
  const invalid = path.join(root, 'other.exe');
  fs.writeFileSync(invalid, '');
  assert.throws(() => electronDistribution('win32', () => invalid), /Unexpected/);
});

test('neutral distribution versions are explicit bounded semver values, not command fragments', () => {
  for (const version of ['0.6.4-preview', '0.6.4-preview.1', '1.2.3']) assert.equal(distributionVersion(version), version);
  for (const version of ['', '01.2.3', '99999.0.0', '1.2', '1.2.3;exit', '1.2.3-beta']) {
    assert.throws(() => distributionVersion(version));
  }
});

test('native distribution child cannot inherit credentials, module search paths or preloads', () => {
  const env = childEnv('synthetic-profile');
  for (const name of Object.keys(env)) {
    assert.doesNotMatch(name, /TOKEN|PASSWORD|SECRET|CREDENTIAL|NODE_PATH|NODE_OPTIONS/i);
  }
  assert.equal(env.USERPROFILE, 'synthetic-profile');
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
});

test('final desktop starts the locked browser host with early isolated paths and unchanged strict budgets', () => {
  const root = path.resolve('synthetic final launch');
  const executable = path.join(root, 'electron.exe'), entry = path.join(root, 'fixture.cjs');
  const resources = path.join(root, 'fresh resources'), authority = path.join(root, 'authority.json');
  const profile = path.join(root, 'owned profile'), progress = path.join(root, 'progress.jsonl');
  const log = path.join(profile, 'chromium.log');
  const launch = finalDesktopLaunch(executable, entry, resources, authority, profile, progress, log);
  assert.equal(launch.executable, executable);
  assert.deepEqual(launch.args, ['--enable-logging=file', '--log-level=2', `--log-file=${log}`, `--user-data-dir=${profile}`,
    entry, '--ci-final-native-delivery', resources, authority]);
  assert.equal(launch.options.cwd, profile);
  assert.equal(launch.options.timeout, 65000);
  assert.equal(launch.options.maxBuffer, 262144);
  assert.equal(launch.options.windowsHide, true);
  assert.equal(launch.options.env.GITHUB_ACTIONS, 'true');
  assert.equal(launch.options.env.VI_FIXTURE_PROFILE, profile);
  assert.equal(launch.options.env.VI_FIXTURE_PROGRESS, progress);
  assert.equal(launch.options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(launch.options.env.USERPROFILE, profile);
  for (const name of Object.keys(launch.options.env)) {
    assert.doesNotMatch(name, /TOKEN|PASSWORD|SECRET|CREDENTIAL|NODE_PATH|NODE_OPTIONS|DISABLE_SANDBOX/i);
  }
  assert.doesNotMatch(launch.args.join(' '), /no-sandbox|disable-gpu|ignore-certificate/);
  assert.throws(() => finalDesktopLaunch('relative.exe', entry, resources, authority, profile, progress, log), /absolute/);
});

test('final desktop launch diagnostics distinguish absent JS entry from native log sites without raw content', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-final-launch-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const progress = path.join(root, 'progress.jsonl'), log = path.join(root, 'native.log');
  const result = { pid: 42, status: 0x80000003, signal: null, stdout: '\r\n', stderr: '' };
  const absent = finalDesktopDiagnostics(result, progress, log);
  assert.equal(absent.progress.status, 'absent');
  assert.equal(absent.stdoutBytes, 2);
  assert.equal(absent.stderrBytes, 0);
  assert.equal(absent.windowsStatusHex, '0x80000003');
  assert.deepEqual(absent.progress.entries, []);
  fs.writeFileSync(progress, '');
  assert.equal(finalDesktopDiagnostics(result, progress, log).progress.status, 'empty');
  fs.writeFileSync(progress, `${JSON.stringify({ pid: 42, stage: 'js-entry' })}\n`);
  fs.writeFileSync(log, `${'PRIVATE_PREFIX\n'.repeat(4000)}[42:17:FATAL:base\\owned_check.cc:123] PRIVATE_PAYLOAD\n`);
  const entered = finalDesktopDiagnostics(result, progress, log);
  assert.equal(entered.progress.status, 'verified');
  assert.deepEqual(entered.progress.entries, [{ pid: 42, stage: 'js-entry' }]);
  assert.equal(entered.nativeLog.sampledBytes, 32768);
  assert.equal(entered.nativeLog.truncated, true);
  assert.deepEqual(entered.nativeLog.sites, [{ severity: 'fatal', file: 'owned_check.cc', line: 123 }]);
  assert.doesNotMatch(JSON.stringify(entered), /PRIVATE|PAYLOAD|PREFIX|base\\|text/);
  for (const entry of [{ pid: 99, stage: 'js-entry' }, { pid: 42, stage: 'PRIVATE_STAGE' },
    { pid: 42, stage: 'js-entry', message: 'PRIVATE_MESSAGE' }]) {
    fs.writeFileSync(progress, JSON.stringify(entry));
    const invalid = finalDesktopDiagnostics(result, progress, log);
    assert.equal(invalid.progress.status, 'invalid');
    assert.deepEqual(invalid.progress.entries, []);
    assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE/);
  }
  fs.writeFileSync(progress, 'x'.repeat(9000));
  assert.equal(finalDesktopDiagnostics(result, progress, log).progress.status, 'invalid');
  assert.equal(finalDesktopDiagnostics({ ...result, status: -2147483645 }, progress, log).windowsStatusHex, '0x80000003');
  const timedOut = finalDesktopDiagnostics({ ...result, status: null, signal: 'SIGTERM',
    error: { code: 'ETIMEDOUT', message: 'PRIVATE_SPAWN_PATH' } }, progress, log);
  assert.equal(timedOut.spawnError, 'ETIMEDOUT');
  assert.equal(timedOut.signal, 'SIGTERM');
  assert.equal(timedOut.windowsStatusHex, null);
  assert.doesNotMatch(JSON.stringify(timedOut), /PRIVATE/);
  const nonFile = path.join(root, 'non-file');
  fs.mkdirSync(nonFile);
  const readFailure = finalDesktopDiagnostics(result, nonFile, log);
  assert.equal(readFailure.progress.status, 'read-error');
  assert.ok(['not-file', 'EISDIR', 'EPERM', 'EACCES'].includes(readFailure.progress.readError));
  assert.equal(readFailure.exitStatus, result.status);
  fs.writeFileSync(log, Array.from({ length: 20 }, (_, line) =>
    `[42:17:ERROR:base\\owned_check.cc:${line + 1}] PRIVATE_PAYLOAD`).join('\n'));
  const bounded = finalDesktopDiagnostics(result, progress, log);
  assert.equal(bounded.nativeLog.sites.length, 8);
  assert.doesNotMatch(JSON.stringify(bounded), /PRIVATE/);
});

test('final extracted gate retains entry stages, exact native HWND and all delivery and cleanup assertions', () => {
  const source = fs.readFileSync(path.resolve('scripts', 'distribution-desktop.cjs'), 'utf8');
  const lifecycle = fs.readFileSync(path.resolve('scripts', 'distribution-desktop-lifecycle.cjs'), 'utf8');
  const entry = source.indexOf("lifecycle.publish('js-entry')");
  assert.ok(entry >= 0 && entry < source.indexOf("require('electron')"));
  for (const text of ['authority.electronSourceExecutableSha256', 'authority.sourceFiles',
    'target.pid, process.pid', 'target.window, editor.getNativeWindowHandle()', "progress('paste-verified')",
    'actualMixedClipboardRestored', 'appMainExercised: false', 'new FinalDesktopLifecycle',
    'lifecycle.finish(error)', 'lifecycle.deadline()']) {
    assert.ok(source.includes(text));
  }
  for (const text of ["this.publish('complete')", 'this.report.helperExited', '2500']) assert.ok(lifecycle.includes(text));
  assert.ok(source.includes('60000'));
  assert.ok(source.includes("app.commandLine.getSwitchValue('user-data-dir'), process.env.VI_FIXTURE_PROFILE"));
  assert.ok(!source.includes("app.commandLine.appendSwitch('user-data-dir'"));
  assert.equal((source.match(/await writeMixedClipboard\(clipboard, ClipboardItem\)/g) || []).length, 1);
  assert.equal((source.match(/await readMixedClipboard\(clipboard\)/g) || []).length, 2);
  assert.ok(source.includes('assert.deepEqual(await readMixedClipboard(clipboard), original)'));
  assert.doesNotMatch(source, /clipboard\.readHTML|clipboard\.write\(/);
  const setup = source.indexOf("require('./owned-foreground.cjs')"), baseline = source.indexOf('const before = new Set');
  const warmup = source.indexOf('await driver.warmup()'), acquisition = source.indexOf('await acquireOwnedForeground(');
  assert.ok([setup, baseline, warmup, acquisition].every((index) => index >= 0));
  assert.ok(setup < baseline && warmup < acquisition);
  assert.ok(source.includes('document.activeElement.tagName'));
  assert.ok(!source.includes('editor.focus()'));
  const workflow = fs.readFileSync(path.resolve('.github', 'workflows', 'native-distribution.yml'), 'utf8');
  assert.ok(workflow.includes('artifacts-ci/distribution/final-desktop.launch.json'));
  assert.ok(!workflow.includes('final-desktop.chromium.log'));
});

test('native base production is manual, read-only and declares exactly the supported native hosts', () => {
  const workflow = fs.readFileSync(path.resolve('.github', 'workflows', 'native-distribution.yml'), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request:|push:|contents: write|secrets\.|macos-.*large|windows-.*large/);
  for (const host of ['windows-2025', 'windows-11-arm', 'macos-15']) assert.ok(workflow.includes(host));
  assert.equal((workflow.match(/- \{ os:/g) || []).length, 3);
});
