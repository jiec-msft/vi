const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { fixtureFiles } = require('../../scripts/caret-fixture-files.cjs');
test('controlled FS stages validate only owned paths and propagate fixed-role failures', async () => {
  const rows = [], root = path.resolve('synthetic-layout');
  const files = fixtureFiles({ root, fs: { lstat: async () => ({ isSymbolicLink: () => false, size: 12 }) },
    stage: (name, error, detail) => rows.push({ name, code: error?.code, ...detail }) });
  await assert.rejects(files.run('write-plugin', path.join(root, 'plugin.json'),
    async () => { throw Object.assign(new Error('PRIVATE_VALUE'), { code: 'EACCES' }); }), { code: 'EACCES' });
  assert.ok(rows.some((row) => row.name === 'fs-rejected' && row.operation === 'write-plugin' && row.code === 'EACCES'));
  assert.ok(rows.some((row) => row.name === 'fs-observation' && row.exists && row.bytes === 12));
  await assert.rejects(files.run('write-index', path.resolve('outside'), async () => {}), { code: 'UNSAFE_FIXTURE_PATH' });
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_VALUE/);
});
test('controlled FS stops waiting at five seconds and never continues to a successful after stage', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rows = [], root = path.resolve('synthetic-layout');
  const files = fixtureFiles({ root, fs: { lstat: async () => ({ isSymbolicLink: () => false, size: 0 }) },
    stage: (name) => rows.push(name) });
  const pending = files.run('mkdir-fixture', path.join(root, 'fixture'), () => new Promise(() => {}));
  await nextTurn();
  t.mock.timers.tick(5000);
  await assert.rejects(pending, { code: 'FIXTURE_FS_TIMEOUT' });
  assert.ok(rows.includes('fs-timeout'));
  assert.equal(rows.includes('fs-after'), false);
});
