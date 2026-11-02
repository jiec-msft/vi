const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { nativeHelperEnvironment } = require('../../app/native-diagnostics.cjs');

test('real Windows clipboard transaction preserves owned mixed formats and concurrent copies', {
  skip: process.platform !== 'win32',
}, () => {
  const env = nativeHelperEnvironment();
  let output;
  try { output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-File',
    path.resolve('test', 'framework', 'fixtures', 'clipboard-transaction.ps1'), '-Source', path.resolve('native')],
  { env, encoding: 'utf8', timeout: 20000, maxBuffer: 65536 }); }
  catch (error) {
    const stages = String(error.stderr || '').split(/\r?\n/).filter((line) =>
      /^VI_CLIP_STAGE (engine \d+ [48] \d+|forms-ready|transaction-compiled|fixture-compiled|case \d{1,2})$/.test(line)).slice(-32);
    const faults = String(error.stderr || '').split(/\r?\n/).filter((line) =>
      /^VI_CLIP_FAILURE (operation|cleanup) case=\d{1,2} code=(fixture-assertion|[a-z-]+)( stage=[a-z-]+ format=\d{1,5} nativeError=-?\d{1,10})?$/.test(line)).slice(-8);
    console.error(JSON.stringify({ scope: 'native-clipboard-fixture', stages, faults,
      timedOut: error.code === 'ETIMEDOUT', status: error.status, signal: error.signal }));
    throw error;
  }
  const report = JSON.parse(output);
  assert.equal(report.status, 'passed');
  assert.equal(report.inputEventsSent, 0);
  assert.equal(report.checks.length, 13);
  assert.ok(report.zeroAllocation.Format >= 0xc000);
  assert.ok((report.zeroAllocation.Flags & 0x4000) !== 0);
  assert.equal(report.zeroAllocation.Bytes, 0);
  assert.equal(typeof report.zeroAllocation.SetSucceeded, 'boolean');
  assert.ok(Number.isInteger(report.zeroAllocation.NativeError) && report.zeroAllocation.NativeError >= 0);
  assert.equal(report.zeroAllocationOutcome,
    report.zeroAllocation.SetSucceeded ? 'clipboard-format' : 'native-publication-rejected');
});
