const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { readFileSync } = require('node:fs');
const { setImmediate: nextTurn } = require('node:timers/promises');
const vm = require('node:vm');

function fixture() {
  const child = new EventEmitter(), commands = [];
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdin.on('data', (data) => commands.push(JSON.parse(data.toString())));
  child.kill = () => { child.killed = true; };
  const context = vm.createContext({ module: { exports: {} },
    require: (name) => name === 'node:child_process' ? { spawn: () => child } : require(name),
    setTimeout, clearTimeout });
  vm.runInContext(readFileSync(require.resolve('../../app/native-delivery.cjs'), 'utf8'), context);
  const driver = new context.module.exports.NativeDelivery('win32', 'owned-resources');
  return { driver, child, commands, reply: (value) => child.stdout.write(`${JSON.stringify(value)}\n`) };
}

test('native clipboard and key queries are serialized on one helper', async () => {
  const f = fixture();
  try {
    const first = f.driver.request('ready'), second = f.driver.request('held', { keys: [17, 32] });
    await nextTurn();
    assert.equal(f.commands.length, 1);
    f.reply({ id: 1, ok: true, value: { ready: true } });
    await first;
    await nextTurn();
    assert.equal(f.commands.length, 2);
    f.reply({ id: 2, ok: true, value: { held: false } });
    assert.equal((await second).held, false);
  } finally { f.driver.close(); }
});

test('native failures expose only fixed messages, not raw helper content', async () => {
  const f = fixture();
  try {
    const pending = f.driver.request('paste', { text: 'owned synthetic transcript' });
    await nextTurn();
    f.reply({ id: 1, ok: false, code: 'restore-failed', error: 'PRIVATE_TOKEN_OR_TRANSCRIPT' });
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 'restore-failed');
      assert.doesNotMatch(error.message, /PRIVATE/);
      assert.match(error.message, /clipboard could not be restored/);
      return true;
    });
  } finally { f.driver.close(); }
});

test('malformed native responses reject the request and terminate only the owned helper', async () => {
  const f = fixture();
  const pending = f.driver.request('ready');
  await nextTurn();
  f.reply({ id: 1, ok: 'true', value: {} });
  await assert.rejects(pending, /invalid response/);
  assert.equal(f.child.killed, true);
  await assert.rejects(f.driver.request('ready'), /closed/);
});

test('target rejection retains only fixed check identifiers, never raw focus details', async () => {
  for (const check of ['accessible-focus', 'PRIVATE_FIELD_OR_TITLE']) {
    const f = fixture();
    try {
      const pending = f.driver.request('paste');
      await nextTurn();
      f.reply({ id: 1, ok: false, code: 'target-changed', check });
      await assert.rejects(pending, (error) => {
        assert.equal(error.check, check === 'accessible-focus' ? check : undefined);
        assert.doesNotMatch(error.message, /PRIVATE/);
        return true;
      });
    } finally { f.driver.close(); }
  }
});

test('native timeout rejects pending work without leaking request text', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const pending = f.driver.request('paste', { text: 'PRIVATE_SYNTHETIC_TEXT' });
  await nextTurn();
  t.mock.timers.tick(8000);
  await assert.rejects(pending, (error) => {
    assert.match(error.message, /timed out/);
    assert.doesNotMatch(error.message, /PRIVATE/);
    return true;
  });
  assert.equal(f.child.killed, true);
});
