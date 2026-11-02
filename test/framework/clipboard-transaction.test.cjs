const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('real Windows clipboard transaction preserves owned mixed formats and concurrent copies', {
  skip: process.platform !== 'win32',
}, () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PSMODULEPATH') delete env[key];
  const report = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-File',
    path.resolve('test', 'framework', 'fixtures', 'clipboard-transaction.ps1'), '-Source', path.resolve('native')],
  { env, encoding: 'utf8', timeout: 20000, maxBuffer: 65536 }));
  assert.equal(report.status, 'passed');
  assert.equal(report.inputEventsSent, 0);
  assert.equal(report.checks.length, 11);
});
