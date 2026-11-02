const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { endpoint, siblingConfig, readConfig, providerOptions } = require('../app/provider-config.cjs');

test('data-only provider configuration precedence preserves explicit provider roots and user overrides', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vi-data-config-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'VI.provider.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, endpoint: 'wss://service.example.invalid/speech' }));
  const options = { bundled: { endpoint: 'wss://bundled.example.invalid' },
    executable: path.join(root, 'VI.exe'), platform: 'win32', packaged: true };
  assert.equal(providerOptions(options).endpoint, 'wss://service.example.invalid/speech');
  assert.equal(providerOptions({ ...options, explicitProviderDirectory: true }).endpoint, options.bundled.endpoint);
  assert.equal(providerOptions({ ...options, explicitProviderDirectory: true, explicitConfig: file }).endpoint,
    'wss://service.example.invalid/speech');
  assert.equal(providerOptions({ ...options, override: { endpointOverride: 'ws://127.0.0.1:12345' } }).endpoint,
    'ws://127.0.0.1:12345');
  assert.throws(() => providerOptions({ ...options, explicitConfig: path.join(root, 'missing.json') }), /could not be read/);
  assert.throws(() => providerOptions({ ...options, explicitConfig: '' }), /absolute/);
  fs.rmSync(file);
  assert.throws(() => providerOptions({ ...options, bundled: {} }), /not configured/);
  assert.equal(siblingConfig(path.join(root, 'VI.app', 'Contents', 'MacOS', 'VI'), 'darwin'), file);
});

test('external configuration rejects executable options, oversized data, symlinks and unsafe endpoints', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vi-data-validation-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'data.json');
  for (const data of ['{', '[]', '{"schemaVersion":2,"endpoint":"wss://example.invalid"}',
    '{"schemaVersion":1,"endpoint":"wss://example.invalid","entry":"other.cjs"}', ' '.repeat(4097)]) {
    fs.writeFileSync(file, data);
    assert.throws(() => readConfig(file, true));
  }
  assert.throws(() => readConfig('relative.json', true), /absolute/);
  for (const value of ['ws://remote.invalid', 'wss://user:password@example.invalid',
    'wss://example.invalid?token=synthetic', 'file:///data', 'wss://example.invalid/#value', '']) {
    assert.throws(() => endpoint(value));
  }
  assert.equal(endpoint('ws://[::1]:12345'), 'ws://[::1]:12345');
  if (process.platform !== 'win32') {
    fs.writeFileSync(file, '{"schemaVersion":1,"endpoint":"wss://example.invalid"}');
    const link = path.join(root, 'link.json');
    fs.symlinkSync(file, link);
    assert.throws(() => readConfig(link, true), /symbolic links/);
  } else {
    const directory = path.join(root, 'directory');
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'data.json'), '{"schemaVersion":1,"endpoint":"wss://example.invalid"}');
    const junction = path.join(root, 'junction');
    fs.symlinkSync(directory, junction, 'junction');
    assert.throws(() => readConfig(path.join(junction, 'data.json'), true), /symbolic links/);
  }
});
