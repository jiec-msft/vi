const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hostedGuard } = require('./windows-ci-desktop-probe.cjs');
const vm = require('node:vm');
const { setImmediate: nextTurn } = require('node:timers/promises');
const valid = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows',
  GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', VI_EXPECTED_ARCH: 'x64' };
test('hosted guard refuses local, self-hosted, wrong platform, emulation and missing run identity', () => {
  assert.doesNotThrow(() => hostedGuard(valid, 'win32', 'x64'));
  assert.doesNotThrow(() => hostedGuard({ ...valid, VI_EXPECTED_ARCH: 'arm64' }, 'win32', 'arm64'));
  for (const [key, values] of Object.entries({
    GITHUB_ACTIONS: ['', 'false', 'True'], RUNNER_ENVIRONMENT: ['', 'self-hosted'],
    RUNNER_OS: ['', 'Linux'], GITHUB_RUN_ID: ['', '0', 'abc'],
    GITHUB_RUN_ATTEMPT: ['', '0', '1x'], VI_EXPECTED_ARCH: ['', 'arm64', 'ia32'],
  })) {
    for (const value of values) assert.throws(() => hostedGuard({ ...valid, [key]: value }, 'win32', 'x64'));
  }
  assert.throws(() => hostedGuard(valid, 'darwin', 'x64'));
  assert.throws(() => hostedGuard(valid, 'win32', 'arm64'));
  assert.throws(() => hostedGuard({}, 'win32', 'x64'));
});
test('PowerShell guard precedes compilation and any native entry point', () => {
  const source = fs.readFileSync(path.join(__dirname, 'windows-ci-desktop.ps1'), 'utf8');
  const guard = source.indexOf("$env:GITHUB_ACTIONS -cne 'true'");
  assert.ok(guard >= 0 && guard < source.indexOf('Add-Type -Path'));
  assert.ok(source.indexOf('Add-Type -Path') < source.indexOf('[ViCiDesktop]::Run'));
  assert.match(source, /RUNNER_ENVIRONMENT -cne 'github-hosted'/);
});
test('PowerShell local invocation refuses before loading the native type', () => {
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File',
    path.join(__dirname, 'windows-ci-desktop.ps1'), '-Case', 'policy'],
  { env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '' }, encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires a native GitHub-hosted Actions Windows job/);
  assert.doesNotMatch(result.stderr, /Add-Type|Compiler|DllNotFound/);
});
test('Electron fixture bootstrap does not require Node require.main identity before writing its own started receipt', async () => {
  const writes = [];
  const app = { setPath() {}, commandLine: { appendSwitch() {} }, whenReady: () => new Promise(() => {}) };
  const context = vm.createContext({
    module: { exports: {} }, __dirname,
    process: { versions: { electron: '45.1.0' }, env: valid, platform: 'win32', arch: 'x64', pid: 42,
      argv: ['electron', 'probe', '--desktop-probe-role=default', '--desktop-probe-case=normal',
        '--desktop-probe-name=Default', '--desktop-probe-output=synthetic-owned-output'] },
    require: (name) => name === 'node:fs/promises' ? { writeFile: async (file, text) => writes.push({ file, text }) }
      : name === 'electron' ? { app }
        : name === './windows-hosted-guard.cjs' ? { hostedGuard: () => hostedGuard(valid, 'win32', 'x64') }
          : name === './desktop-evidence.cjs' ? { recordDesktop: assert.fail } : require(name),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'windows-ci-desktop-probe.cjs'), 'utf8'), context);
  await nextTurn();
  assert.equal(writes.length, 1);
  assert.equal(path.basename(writes[0].file), 'started.json');
  assert.equal(JSON.parse(writes[0].text).pid, 42);
});
