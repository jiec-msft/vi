const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProvider } = require('../src/provider-host.cjs');
const { providerSetup, providerErrorKind } = require('../app/provider-error.cjs');

test('provider setup preserves missing dependency evidence and is not classified as network failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-provider-error-'));
  try {
    fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({
      kind: 'service-provider', apiVersion: 1, entry: 'index.cjs',
    }));
    fs.writeFileSync(path.join(root, 'index.cjs'), "require('./missing-dependency.cjs');");
    assert.throws(() => loadProvider(root, {}), (error) => {
      assert.equal(error.code, 'ERR_PROVIDER_SETUP');
      assert.equal(providerErrorKind(error), 'provider');
      assert.equal(error.cause.code, 'MODULE_NOT_FOUND');
      assert.match(error.message, /Provider setup failed: Cannot find module/);
      assert.match(error.message, /missing-dependency/);
      return true;
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('normal provider construction is unchanged and asynchronous transport failures remain cloud errors', async () => {
  const failure = Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' });
  const provider = { start: async () => { throw failure; } };
  assert.equal(providerSetup(() => provider), provider);
  await assert.rejects(provider.start(), (error) => {
    assert.equal(error, failure);
    assert.equal(providerErrorKind(error), 'cloud');
    return true;
  });
});
