const assert = require('node:assert/strict');
const { test } = require('node:test');
const { CaretIndicator } = require('../../app/caret-indicator.cjs');
const { preferences } = require('../../app/preferences.cjs');
const { DesktopInput } = require('../../app/desktop.cjs');
const pause = () => new Promise((resolve) => setImmediate(resolve));
const run = () => ({ target: { window: '1', focus: '2', pid: 3, caretLease: true } });
function driver(sample) {
  return { actions: [], closed: false, close() { this.closed = true; },
    async request(action) {
      this.actions.push(action);
      if (action === 'sample') return sample;
      if (action === 'show') return { visible: true };
      return { ready: true };
    } };
}
test('caret preference is explicit, persisted and strictly boolean', () => {
  assert.equal(preferences().caretIndicator, false);
  assert.equal(preferences({ caretIndicator: true }).caretIndicator, true);
  assert.throws(() => preferences({ caretIndicator: 'true' }), /Invalid caretIndicator/);
});
test('unsupported platforms, disabled settings and preview never start a helper', () => {
  const createDriver = () => { throw new Error('Must remain lazy.'); };
  for (const platform of ['darwin', 'linux']) {
    new CaretIndicator({ platform, createDriver }).update(run(), 'recording', true);
  }
  const indicator = new CaretIndicator({ platform: 'win32', createDriver });
  indicator.update(run(), 'recording', false);
  indicator.update({}, 'recording', true);
  indicator.update(run(), 'idle', true);
});
test('actual recording shows the shared adjacent placement and completion closes helper', async () => {
  const native = driver({ status: 'available', token: 1,
    caret: { x: 100, y: 100, width: 1, height: 20 },
    monitor: { scale: 1, workArea: { x: 0, y: 0, width: 800, height: 600 } } });
  const indicator = new CaretIndicator({ platform: 'win32', createDriver: () => native });
  const active = run();
  indicator.update(active, 'recording', true);
  await pause();
  assert.equal(indicator.state, 'visible');
  assert.deepEqual(native.actions, ['ready', 'bind', 'sample', 'show']);
  indicator.update(active, 'finishing', true);
  assert.equal(native.closed, false);
  indicator.update(undefined, 'done', true);
  assert.equal(native.closed, true);
});
test('focus/security/stale failure invalidates lease and cannot revive the same turn', async () => {
  for (const reason of ['target-changed', 'secure-field', 'stale-query', 'desktop-unavailable']) {
    const native = driver({ status: 'blocked', reason });
    const indicator = new CaretIndicator({ platform: 'win32', createDriver: () => native });
    const active = run();
    indicator.update(active, 'recording', true);
    await pause();
    assert.equal(active.target.caretInvalidated, true);
    assert.equal(native.closed, true);
    assert.equal(indicator.state, reason);
    indicator.update(active, 'recording', true);
    assert.equal(native.actions.filter((action) => action === 'bind').length, 1);
  }
});
test('late ready/sample completion after cancel cannot show or mutate a new turn', async () => {
  let resolveSample;
  const native = driver();
  native.request = async (action) => {
    native.actions.push(action);
    if (action === 'sample') return new Promise((resolve) => { resolveSample = resolve; });
    return { ready: true };
  };
  const indicator = new CaretIndicator({ platform: 'win32', createDriver: () => native });
  const active = run();
  indicator.update(active, 'recording', true);
  await pause();
  indicator.update(undefined, 'cancelling', true);
  resolveSample({ status: 'available' });
  await pause();
  assert.equal(native.closed, true);
  assert.equal(native.actions.includes('show'), false);
  assert.equal(active.target.caretInvalidated, undefined);
});
test('invalid caret lease skips final delivery without starting or changing native driver', async () => {
  let created = false, reason;
  const desktop = new DesktopInput({ platform: 'win32', createDriver: () => { created = true; } });
  const target = { ...run().target, caretInvalidated: true };
  assert.equal(await desktop.paste('Synthetic final', target, undefined, (value) => { reason = value; }), false);
  assert.equal(reason, 'target-changed');
  assert.equal(created, false);
});
