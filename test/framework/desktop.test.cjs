const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DesktopInput } = require('../../app/desktop.cjs');

function fixture(platform = 'win32') {
  const calls = [], driver = { closed: false,
    async request(action, data) {
      calls.push({ action, ...data });
      if (this.failure) throw this.failure;
      return action === 'capture' ? { window: '1', focus: '2', pid: 3 }
        : { ready: true, held: false, requested: true, placedBehind: true };
    }, close() { this.closed = true; } };
  const desktop = new DesktopInput({ platform, createDriver: () => driver });
  return { desktop, driver, calls };
}

for (const platform of ['win32', 'darwin']) test(`final delivery uses one native clipboard transaction (${platform})`, async () => {
  const { desktop, calls } = fixture(platform);
  const target = await desktop.capture();
  assert.equal(await desktop.paste('Final transcript', target), true);
  assert.deepEqual(calls.map((call) => call.action), ['ready', 'capture', 'paste']);
  assert.equal(calls.at(-1).text, 'Final transcript');
});

test('Windows settings order uses only the app handle and process, never field contents or paste', async () => {
  for (const size of [4, 8]) {
    const { desktop, calls } = fixture();
    const handle = Buffer.alloc(size);
    if (size === 8) handle.writeBigUInt64LE(1234567890123n);
    else handle.writeUInt32LE(12345);
    assert.equal(await desktop.settleWindow(handle), true);
    assert.deepEqual(calls.map(({ action }) => action), ['ready', 'settle-window']);
    assert.equal(calls[1].window, size === 8 ? '1234567890123' : '12345');
    assert.equal(calls[1].owner, process.pid);
    assert.equal(calls[1].text, undefined);
  }
});

test('window-order errors are explicit and macOS does not call the Windows method', async () => {
  const { desktop, driver, calls } = fixture();
  await assert.rejects(desktop.settleWindow(Buffer.alloc(3)), /Invalid settings window/);
  assert.equal(calls.length, 0);
  await desktop.warmup();
  driver.failure = new Error('window ordering failed');
  await assert.rejects(desktop.settleWindow(Buffer.alloc(8)), /window ordering failed/);
  const mac = fixture('darwin');
  await mac.desktop.settleWindow(Buffer.alloc(8));
  assert.equal(mac.calls.length, 0);
});

test('no target and pre-dispatch cancellation never touch the clipboard', async () => {
  const { desktop, calls } = fixture();
  const skipped = [];
  assert.equal(await desktop.paste('text', undefined, undefined, (reason) => skipped.push(reason)), false);
  assert.equal(await desktop.paste('text', { pid: 3 }, AbortSignal.abort(), (reason) => skipped.push(reason)), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(skipped, ['no-target', 'cancelled']);
});

test('changed or secure targets skip once without a retry', async () => {
  const { desktop, driver, calls } = fixture();
  await desktop.warmup();
  driver.failure = Object.assign(new Error('target changed'), { code: 'target-changed', check: 'foreground-window' });
  let reason, check;
  assert.equal(await desktop.paste('text', { pid: 3 }, undefined, (value, detail) => {
    reason = value;
    check = detail;
  }), false);
  assert.equal(reason, 'target-changed');
  assert.equal(check, 'foreground-window');
  assert.equal(calls.filter((call) => call.action === 'paste').length, 1);
});

test('ambiguous paste failures are explicit and cannot become safe-to-retry success', async () => {
  const { desktop, driver } = fixture();
  await desktop.warmup();
  driver.failure = Object.assign(new Error('review before retrying'), { code: 'paste-unconfirmed' });
  await assert.rejects(desktop.paste('text', { pid: 3 }), /review before retrying/);
});

test('release polling and capture reuse the warmed helper without editor reads', async () => {
  const { desktop, calls } = fixture();
  assert.equal(await desktop.held([17, 16, 32]), false);
  await desktop.capture();
  assert.equal(calls.filter((call) => call.action === 'ready').length, 1);
  assert.deepEqual(calls[1].keys, [17, 16, 32]);
});
