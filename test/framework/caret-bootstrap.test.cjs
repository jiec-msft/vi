const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
test('CI bootstrap records bounded roles and safe errors, never raw paths, env or module payload', () => {
  const rows = [], listeners = [];
  const root = path.resolve('scripts');
  const context = vm.createContext({
    module: { exports: {} }, __dirname: root,
    process: { pid: 42, type: 'browser', versions: { electron: '45.1.0' }, cwd: () => path.resolve('.'),
      argv: ['PRIVATE_EXE_PATH', path.join(root, 'windows-caret-ui.cjs'), '--user-data-dir=PRIVATE_PROFILE'],
      env: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'jiec-msft/vi',
        VI_CARET_TRUSTED_HEAD: 'true', VI_PROBE_HEAD: 'a'.repeat(40), GITHUB_RUN_ID: '123',
        PRIVATE_ENDPOINT: 'PRIVATE_TOKEN', ELECTRON_RUN_AS_NODE: '' },
      on: (_event, listener) => listeners.push(listener), stderr: { write: assert.fail } },
    require: (name) => name === 'node:fs' ? { appendFileSync: (_file, row) => rows.push(JSON.parse(row)) } : require(name),
  });
  test('actual App root imports production main synchronously before starting asynchronous acceptance', () => {
    const order = [];
    vm.runInNewContext(fs.readFileSync(path.resolve('scripts', 'caret-app-root.cjs'), 'utf8'), {
      require: (name) => {
        if (name === './caret-bootstrap-trace.cjs') return { stage: (value) => order.push(value) };
        if (name === './windows-hosted-guard.cjs') return { hostedGuard: () => order.push('guard') };
        if (name === './windows-caret-ui.cjs') return { runAcceptance: () => order.push('acceptance') };
        if (name === '../app/main.cjs') { order.push('actual-production-main'); return {}; }
        throw new Error('Unexpected root import.');
      },
    });
    assert.ok(order.indexOf('actual-production-main') > order.indexOf('guard'));
    assert.ok(order.indexOf('actual-production-main') < order.indexOf('acceptance'));
  });
  vm.runInContext(fs.readFileSync(path.resolve('scripts', 'caret-bootstrap-trace.cjs'), 'utf8'), context);
  context.module.exports.stage('entry-loaded');
  listeners[0](Object.assign(new Error('PRIVATE_MODULE_URL'), { code: 'MODULE_NOT_FOUND' }));
  assert.equal(rows[0].entryRole, 'caret-controller');
  assert.equal(rows[0].profileSwitchPresent, true);
  assert.equal(rows[0].processRole, 'browser');
  assert.equal(rows[0].runAsNodePresent, true);
  assert.equal(rows[0].runAsNodeEnabled, false);
  assert.equal(rows[1].errorCode, 'MODULE_NOT_FOUND');
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|profile=|URL/);
  assert.throws(() => context.module.exports.stage('PRIVATE_STAGE'), /Invalid bootstrap stage/);
});
