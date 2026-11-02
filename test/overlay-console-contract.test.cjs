const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { packagingShellContext } = require('../scripts/distribution.cjs');

test('console completion, exit and failure witness contracts reject wrong paths without registry or child actions', {
  skip: process.platform !== 'win32',
}, () => {
  const shell = packagingShellContext();
  const output = execFileSync(shell.executable, ['-NoProfile', '-NonInteractive', '-File',
    path.resolve('test', 'fixtures', 'overlay-console-contract.ps1'), '-Source', path.resolve('scripts')],
  { env: shell.env, windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 16384 });
  const report = JSON.parse(output.trim());
  assert.equal(report.status, 'passed');
  assert.equal(report.scope, 'pure-functions-only-no-registry-or-child-launch');
  assert.equal(report.checks.length, 44);
});
