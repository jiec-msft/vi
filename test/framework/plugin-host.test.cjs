const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { PluginHost } = require('../../app/plugins/host.cjs');
const { descriptor, fakeFork } = require('./support/plugin-process.cjs');

test('host correlates requests, reuses child and does not inherit environment or stdio', async () => {
  const fake = fakeFork({ 'test.algorithm': { hooks: { 'final.transform': async () => ({ outcome: 'keep' }) } } });
  const host = new PluginHost(descriptor(), fake.fork);
  await host.start();
  for (let i = 0; i < 2; i++) assert.equal((await host.call('final.transform', { inputText: 'text', runId: 'run', revision: i })).outcome, 'keep');
  assert.equal(fake.children.length, 1);
  assert.deepEqual(fake.children[0].launch.env, { NODE_ENV: 'production' });
  assert.equal(fake.children[0].launch.stdio, 'ignore');
  await host.close();
  assert.equal(host.didExit, true);
});
test('timeout closes and confirms exit; no retry on the same host', async () => {
  const fake = fakeFork({ 'test.algorithm': { hooks: { 'final.transform': () => new Promise(() => {}) } } });
  const host = new PluginHost(descriptor(), fake.fork);
  await assert.rejects(host.call('final.transform', {}, undefined, 15), /timeout/);
  assert.equal(host.didExit, true);
  await assert.rejects(host.call('final.transform', {}), /closed/);
  assert.equal(fake.children.length, 1);
});
test('cancellation closes in-flight work and ignores late replies', async () => {
  const fake = fakeFork({ 'test.algorithm': { hooks: { 'final.transform': () => new Promise(() => {}) } } });
  const host = new PluginHost(descriptor(), fake.fork);
  await host.start();
  const controller = new AbortController();
  const call = host.call('final.transform', {}, controller.signal);
  controller.abort();
  await assert.rejects(call, /cancelled/);
  assert.equal(host.didExit, true);
});
test('invalid results and plugin exceptions are sanitized and close the child', async () => {
  for (const hook of [() => ({ outcome: 'replace', text: '\0' }), () => { throw new Error('secret transcript'); }]) {
    const fake = fakeFork({ 'test.algorithm': { hooks: { 'final.transform': hook } } });
    const host = new PluginHost(descriptor(), fake.fork);
    await assert.rejects(host.call('final.transform', {}), (error) => !error.message.includes('secret') && error.pluginFailure);
    assert.equal(host.didExit, true);
  }
});
test('unexpected/duplicate replies invalidate an instance instead of being accepted', async () => {
  const fake = fakeFork({});
  const host = new PluginHost(descriptor(), fake.fork);
  await host.start();
  fake.children[0].emit('message', { identity: 'other', requestId: 'old', value: { outcome: 'keep' } });
  await assert.rejects(host.call('final.transform', {}));
  await host.close();
});
test('fork failure returns a fixed error without external exception data', async () => {
  const host = new PluginHost(descriptor(), () => { throw new Error('secret'); });
  await assert.rejects(host.start(), /start-failed/);
});

for (const stage of ['init', 'call']) test(`${stage} cleanup failure preserves the original sanitized cause`, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeFork({ 'test.algorithm': {
    validateConfig: () => ({ valid: stage !== 'init' }),
    hooks: { 'final.transform': () => { throw new Error('private transcript'); } },
  } });
  const fork = (...args) => {
    const child = fake.fork(...args), post = child.postMessage;
    child.postMessage = (message) => { if (message.type !== 'dispose') post(message); };
    child.kill = () => false;
    return child;
  };
  const host = new PluginHost(descriptor(), fork);
  if (stage === 'call') await host.start();
  const outcome = (stage === 'init' ? host.start() : host.call('final.transform', {})).catch((error) => error);
  await nextTurn();
  if (stage === 'call') { t.mock.timers.tick(100); await nextTurn(); }
  t.mock.timers.tick(250);
  await nextTurn();
  t.mock.timers.tick(1000);
  const error = await outcome;
  assert.equal(error.code, 'termination-failed');
  assert.equal(error.cause.code, 'plugin-error');
  assert.notEqual(error.cause, error);
  assert.ok(!error.cause.message.includes('private transcript'));
  fake.children[0].emit('exit', 0);
});

test('a child that spawns after initialization timeout is still terminated', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeFork({}, { noReply: true });
  let spawned = false;
  const fork = (...args) => {
    const child = fake.fork(...args), kill = child.kill;
    child.kill = () => spawned ? kill() : false;
    return child;
  };
  const host = new PluginHost(descriptor(), fork);
  const outcome = host.start().catch((error) => error);
  t.mock.timers.tick(2000);
  await nextTurn();
  assert.equal(host.closed, true);
  spawned = true;
  fake.children[0].emit('spawn');
  await nextTurn();
  t.mock.timers.tick(250);
  await nextTurn();
  t.mock.timers.tick(1000);
  const error = await outcome;
  assert.equal(error.code, 'timeout');
  assert.equal(host.didExit, true);
});
