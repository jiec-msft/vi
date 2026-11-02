const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { fileInventory } = require('../scripts/distribution-files.cjs');
const { distributionVersion, childEnv, electronDistribution, packagingShellContext,
  validatePackagingShell, probePackagingShell } = require('../scripts/distribution.cjs');

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
  run(['-Root', payload, '-Zip', zip]);
  run(['-Action', 'extract', '-Root', extracted, '-Zip', zip]);
  assert.deepEqual(fileInventory(extracted), fileInventory(payload));
  const bytes = fs.readFileSync(zip);
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
  assert.equal(bytes.readUInt16LE(bytes.length - 12), 3);
  assert.equal(bytes.subarray(30, 30 + bytes.readUInt16LE(26)).toString('utf8').startsWith('./'), false);
  assert.throws(() => run(['-Action', 'extract', '-Root', extracted, '-Zip', zip]), /new directory/);
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

test('native base production is manual, read-only and declares exactly the supported native hosts', () => {
  const workflow = fs.readFileSync(path.resolve('.github', 'workflows', 'native-distribution.yml'), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request:|push:|contents: write|secrets\.|macos-.*large|windows-.*large/);
  for (const host of ['windows-2025', 'windows-11-arm', 'macos-15']) assert.ok(workflow.includes(host));
  assert.equal((workflow.match(/- \{ os:/g) || []).length, 3);
});
