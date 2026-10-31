const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProvider } = require('../src/provider-host.cjs');

test('provider host rejects traversal before loading code', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-contract-'));
  try {
    fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({
      kind: 'service-provider', apiVersion: 1, entry: '../outside.cjs',
    }));
    assert.throws(() => loadProvider(root, {}), /manifest/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
