const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { distributionVersion, childEnv, electronDistribution, windowsPowerShellContext } = require('../scripts/distribution.cjs');

test('Windows packaging isolates inbox PowerShell modules from a PowerShell Core parent', () => {
  const systemRoot = path.resolve('synthetic-windows');
  const supplied = { SystemRoot: systemRoot, PATH: 'synthetic-path',
    PSModulePath: 'synthetic-Core-modules', PSMODULEPATH: 'another-Core-path',
    NODE_OPTIONS: 'tool-parent-setting' };
  const original = { ...supplied };
  const context = windowsPowerShellContext(supplied);
  const home = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
  assert.equal(context.executable, path.join(home, 'powershell.exe'));
  assert.equal(context.env.PSModulePath, path.join(home, 'Modules'));
  assert.deepEqual(Object.keys(context.env).filter((name) => name.toUpperCase() === 'PSMODULEPATH'), ['PSModulePath']);
  assert.equal(context.env.PATH, supplied.PATH);
  assert.deepEqual(supplied, original, 'The tool context changed its parent process environment.');
  assert.throws(() => windowsPowerShellContext({}), /SystemRoot/);
  assert.throws(() => windowsPowerShellContext({ SystemRoot: 'relative' }), /absolute/);
  const app = childEnv('synthetic-profile');
  assert.ok(!Object.keys(app).some((name) => name.toUpperCase() === 'PSMODULEPATH'));
});

test('Windows packaging can load actual inbox cmdlets with an incompatible parent module path', {
  skip: process.platform !== 'win32',
}, () => {
  const context = windowsPowerShellContext({ ...process.env, PSModulePath: path.resolve('synthetic-Core-only-modules') });
  const result = JSON.parse(execFileSync(context.executable, ['-NoProfile', '-NonInteractive', '-Command',
    "$s=Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -PassThru -ErrorAction Stop; " +
    "$a=Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Archive\\Microsoft.PowerShell.Archive.psd1') -PassThru -ErrorAction Stop; " +
    '@{edition=$PSVersionTable.PSEdition;security=(Get-Command Get-AuthenticodeSignature -ErrorAction Stop).ModuleName;' +
    'archive=(Get-Command Expand-Archive -ErrorAction Stop).ModuleName}|ConvertTo-Json -Compress'],
  { env: context.env, encoding: 'utf8', timeout: 15000 }));
  assert.deepEqual(result, { edition: 'Desktop', security: 'Microsoft.PowerShell.Security',
    archive: 'Microsoft.PowerShell.Archive' });
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
