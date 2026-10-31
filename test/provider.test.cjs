const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Provider } = require('../src/provider.cjs');
const { fakeService } = require('./fake-service.cjs');

test('provider requires an explicit supported endpoint', () => {
  assert.throws(() => new Provider({ endpoint: 'file:///fixture' }), /transport/);
  assert.throws(() => new Provider({}));
});

test('loopback transport receives PCM and final result without external access', async () => {
  const service = await fakeService();
  const provider = new Provider({ endpoint: service.endpoint, credential: 'fixture-credential' });
  provider.on('failure', (error) => assert.fail(error));
  try {
    await provider.open();
    provider.audio(Buffer.alloc(2048));
    assert.equal(await provider.finish(), 'Fixture final text');
    assert.equal(service.bytes(), 2048);
  } finally { provider.close(); await service.close(); }
});

test('invalid audio is rejected before dispatch', async () => {
  const provider = new Provider({ endpoint: 'ws://127.0.0.1:1' });
  assert.throws(() => provider.audio(Buffer.alloc(1)), /PCM/);
  assert.throws(() => provider.audio(Buffer.alloc(32002)), /PCM/);
});
