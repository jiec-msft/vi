const { app, BrowserWindow, screen } = require('electron');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'win32' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || !process.env.VI_OUTPUT) {
  throw new Error('Failure-release checks require an isolated GitHub-hosted Windows runner.');
}
const execute = promisify(execFile), directory = path.resolve(process.env.VI_OUTPUT);
const report = { scope: 'two owned fixture windows; normal failure remains nonzero', checks: [] };
let main, overlay, other, ownedDown;
const handle = (window) => window.getNativeWindowHandle().readBigUInt64LE().toString();
async function input(mode, cleanup = false, receipt = undefined) {
  const bounds = overlay.getBounds();
  const point = screen.dipToScreenPoint({ x: bounds.x + 30, y: bounds.y + 25 });
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.resolve('test', 'framework', 'fixtures', 'overlay-mouse.ps1'),
    '-Window', handle(overlay), '-Foreground', handle(main), '-Owner', String(process.pid),
    '-Mode', mode, '-X', String(point.x), '-Y', String(point.y)];
  if (cleanup) {
    args.push('-CleanupOwnedDown');
    if (receipt) args.push('-OwnedDownReceipt', JSON.stringify(receipt));
  }
  try {
    const result = await execute('powershell.exe', args, { timeout: 15000, windowsHide: true });
    const value = JSON.parse(result.stdout.trim());
    if (value.ownedDownInjected && value.ownerVerified && value.leftHeldAfter) ownedDown = value;
    if (mode === 'up' && value.leftHeldAfter === false) ownedDown = undefined;
    return value;
  } catch (error) {
    if (error.stdout?.trim()) {
      const value = JSON.parse(error.stdout.trim());
      if (value.ownedDownInjected && value.ownerVerified && value.leftHeldAfter) ownedDown = value;
    }
    throw error;
  }
}
async function rejectedCleanup(label) {
  const before = await input('status');
  await assert.rejects(input('up', true), /owned native down receipt/);
  const after = await input('status');
  assert.equal(after.leftHeldAfter, before.leftHeldAfter, 'Unconfirmed cleanup changed a mouse press.');
  report[label] = { rejected: true, heldBefore: before.leftHeldAfter, heldAfter: after.leftHeldAfter };
}
async function run() {
  await app.whenReady();
  const area = screen.getPrimaryDisplay().workArea;
  main = new BrowserWindow({ show: false, x: area.x + 10, y: area.y + 10, width: 500, height: 350 });
  overlay = new BrowserWindow({ show: false, x: area.x + 40, y: area.y + 80, width: 224, height: 54,
    frame: false, focusable: false, alwaysOnTop: true });
  other = new BrowserWindow({ show: false, x: area.x + 300, y: area.y + 200, width: 300, height: 200 });
  await Promise.all([main.loadURL('data:text/html,Owned%20baseline'), overlay.loadURL('data:text/html,Owned%20mouse%20target'),
    other.loadURL('data:text/html,Owned%20foreground%20fault')]);
  main.show(); main.focus(); overlay.showInactive();
  await new Promise((resolve) => setTimeout(resolve, 300));
  report.windowIds = { owner: process.pid, main: handle(main), overlay: handle(overlay), other: handle(other) };
  await rejectedCleanup('noOwnedDown');
  const first = await input('down');
  assert.equal(first.ownedDownInjected, true);
  assert.equal(first.leftHeldAfter, true);
  await input('up');
  assert.equal(ownedDown, undefined);
  const second = await input('down');
  assert.equal(second.ownedDownInjected, true);
  assert.equal(second.leftHeldAfter, true);
  await rejectedCleanup('newPressWithoutAuthority');
  assert.equal((await input('status')).leftHeldAfter, true);
  other.show(); other.focus();
  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    await input('up');
    throw new Error('Normal mouse-up unexpectedly bypassed the fixed foreground baseline.');
  } catch (error) {
    if (error.code !== 1 || !error.stderr?.includes('baseline changed before input')) throw error;
    report.originalFailure = { exitCode: error.code, expectedBaselineGuard: true };
    report.heldAfterRejectedNormalUp = (await input('status')).leftHeldAfter;
    assert.equal(report.heldAfterRejectedNormalUp, true, 'Normal failed mouse-up had already released the press.');
  } finally {
    if (ownedDown) {
      report.cleanup = await input('up', true, ownedDown);
      assert.equal(report.cleanup.leftHeldBefore, true);
      assert.equal(report.cleanup.leftHeldAfter, false);
      assert.equal(report.cleanup.releaseSent, true);
      assert.equal(report.cleanup.cleanupUpOnly, true);
      assert.equal(report.cleanup.foregroundUnchanged, true);
    }
  }
  assert.equal((await input('status')).leftHeldAfter, false);
  report.status = 'expected-failure-cleaned';
}
run().catch((error) => {
  report.status = 'failed';
  report.error = error.message;
}).finally(async () => {
  if (ownedDown) {
    try { report.emergencyCleanup = await input('up', true, ownedDown); }
    catch (error) { report.cleanupError = error.message; report.remainingHeld = true; }
  }
  await fs.writeFile(path.join(directory, 'release-negative.json'), JSON.stringify(report, null, 2));
  app.exit(report.status === 'expected-failure-cleaned' ? 1 : 2);
});
