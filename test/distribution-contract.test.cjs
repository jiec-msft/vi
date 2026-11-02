const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { distributionVersion, childEnv, electronDistribution } = require('../scripts/distribution.cjs');

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
