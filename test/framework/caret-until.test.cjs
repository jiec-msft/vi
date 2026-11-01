const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { until } = require('../../scripts/caret-until.cjs');
test('absolute observer deadline rejects a never-settling action and ignores late completion', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve, calls = 0;
  const pending = until(() => { calls++; return new Promise((done) => { resolve = done; }); }, 'owned-ready', 40000);
  await nextTurn();
  t.mock.timers.tick(40000);
  await assert.rejects(pending, { code: 'CI_ACTION_TIMEOUT' });
  resolve(true);
  await nextTurn();
  assert.equal(calls, 1);
});
test('observer retains the genuine predicate and surfaces fixed rejection without raw content', async () => {
  assert.equal(await until(async () => 'real-ready', 'ready'), 'real-ready');
  await assert.rejects(until(async () => { throw new Error('PRIVATE_PAYLOAD'); }, 'owned-ready'), (error) => {
    assert.equal(error.code, 'CI_ACTION_REJECTED');
    assert.doesNotMatch(error.message, /PRIVATE/);
    return true;
  });
});
