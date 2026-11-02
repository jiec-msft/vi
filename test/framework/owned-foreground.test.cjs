const { test } = require('node:test');
const assert = require('node:assert/strict');
const { acquireOwnedForeground } = require('../../scripts/owned-foreground.cjs');

function fixture(targets = [{ pid: 42, window: '123' }]) {
  let time = 0, ready = false, captures = 0, focuses = 0;
  const events = [], observations = [], handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(123n);
  const window = { isDestroyed: () => false, isVisible: () => true, isFocusable: () => true,
    getNativeWindowHandle: () => handle, focus: () => {
      assert.equal(ready, true, 'Native helper READY must precede owned focus acquisition.');
      focuses++; events.push('focus');
    } };
  const driver = { warmup: async () => { ready = true; events.push('ready'); },
    capture: async () => { events.push('capture'); return targets[Math.min(captures++, targets.length - 1)]; } };
  return { options: { driver, window, ownerPid: 42, rendererReady: async () => true,
    onAttempt: (value) => { if (typeof value.rendererReady === 'boolean') observations.push(value); } },
  clock: { now: () => time, wait: async (ms) => { time += ms; } }, advance: (ms) => { time += ms; },
  events, observations, focuses: () => focuses, captures: () => captures };
}

test('owned acquisition waits for native READY and requires both native PID and exact HWND', async () => {
  const f = fixture([{ pid: 99, window: '123' }, { pid: 42, window: '999' },
    { pid: 0, window: '0' }, { pid: 42, window: '123' }]);
  const actual = await acquireOwnedForeground(f.options, f.clock);
  assert.deepEqual(actual, { pid: 42, window: '123' });
  assert.equal(f.events[0], 'ready');
  assert.equal(f.focuses(), 4);
  assert.deepEqual(f.observations.map((value) => [value.nativeOwner, value.nativeWindowMatched]),
    [['foreign', true], ['owned', false], ['unavailable', false], ['owned', true]]);
});

test('renderer focus cannot waive a foreign native baseline or an unavailable native owner', async () => {
  for (const target of [{ pid: 99, window: '123' }, { pid: 0, window: '0' }]) {
    const f = fixture([target]);
    await assert.rejects(acquireOwnedForeground(f.options, f.clock),
      { code: 'owned-focus-timeout', message: /5000 ms/ });
    assert.equal(f.focuses(), 50);
    assert.equal(f.captures(), 50);
    assert.ok(f.observations.every((value) => value.rendererReady));
  }
});

test('a late native match is not accepted beyond the acquisition deadline', async () => {
  const f = fixture();
  f.options.driver.capture = async () => { f.advance(5000); return { pid: 42, window: '123' }; };
  await assert.rejects(acquireOwnedForeground(f.options, f.clock), { code: 'owned-focus-timeout' });
  assert.equal(f.focuses(), 1);
});

test('a native match still requires the owned renderer to be ready', async () => {
  const f = fixture();
  let samples = 0;
  f.options.rendererReady = async () => ++samples > 1;
  await acquireOwnedForeground(f.options, f.clock);
  assert.equal(f.focuses(), 2);
  assert.deepEqual(f.observations.map((value) => value.rendererReady), [false, true]);
});

test('a stalled native capture cannot extend the owned acquisition budget', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.options.driver.capture = () => new Promise(() => {});
  const rejected = assert.rejects(acquireOwnedForeground(f.options, f.clock), { code: 'owned-focus-timeout' });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(5000);
  await rejected;
  assert.equal(f.focuses(), 1);
});

test('owned acquisition never focuses an unfocusable overlay or absorbs a native failure', async () => {
  const overlay = fixture();
  overlay.options.window.isFocusable = () => false;
  await assert.rejects(acquireOwnedForeground(overlay.options, overlay.clock), { code: 'owned-focus-unavailable' });
  assert.equal(overlay.focuses(), 0);
  assert.deepEqual(overlay.events, []);
  const invalid = fixture();
  invalid.options.window.getNativeWindowHandle = () => Buffer.alloc(8);
  await assert.rejects(acquireOwnedForeground(invalid.options, invalid.clock), { code: 'owned-focus-unavailable' });
  assert.equal(invalid.focuses(), 0);
  const f = fixture();
  const error = new Error('Owned native capture failed.');
  f.options.driver.capture = async () => { throw error; };
  await assert.rejects(acquireOwnedForeground(f.options, f.clock), (actual) => actual === error);
  assert.equal(f.focuses(), 1);
  const cold = fixture();
  cold.options.driver.warmup = async () => { throw error; };
  await assert.rejects(acquireOwnedForeground(cold.options, cold.clock), (actual) => actual === error);
  assert.equal(cold.focuses(), 0);
});
