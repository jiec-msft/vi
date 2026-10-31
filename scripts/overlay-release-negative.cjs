const { app, BrowserWindow, screen, nativeImage } = require('electron');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { recordDesktop } = require('./desktop-evidence.cjs');

if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'win32' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || !process.env.VI_OUTPUT) {
  throw new Error('Failure-release checks require an isolated GitHub-hosted Windows runner.');
}
const execute = promisify(execFile), directory = path.resolve(process.env.VI_OUTPUT);
const expectedDesktop = process.argv.find((arg) => arg.startsWith('--ci-owned-desktop='))?.slice('--ci-owned-desktop='.length);
const desktopReceipt = process.argv.find((arg) => arg.startsWith('--ci-desktop-receipt='))?.slice('--ci-desktop-receipt='.length);
const report = { scope: 'two owned fixture windows; normal failure remains nonzero', checks: [], osInputs: [] };
let main, overlay, other, ownedDown;
const handle = (window) => window.getNativeWindowHandle().readBigUInt64LE().toString();
async function input(mode, cleanup = false, receipt = undefined) {
  const bounds = overlay.getBounds();
  const point = screen.dipToScreenPoint({ x: bounds.x + 30, y: bounds.y + 25 });
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.resolve('test', 'framework', 'fixtures', 'overlay-mouse.ps1'),
    '-Window', handle(overlay), '-Foreground', handle(main), '-Owner', String(process.pid),
    '-Mode', mode, '-X', String(point.x), '-Y', String(point.y),
    ...(expectedDesktop ? ['-DesktopName', expectedDesktop, '-JobOutput', desktopReceipt] : [])];
  if (cleanup) {
    args.push('-CleanupOwnedDown');
    if (receipt) args.push('-OwnedDownReceipt', JSON.stringify(receipt));
  }
  try {
    const result = await execute('powershell.exe', args, { timeout: 15000, windowsHide: true });
    const value = JSON.parse(result.stdout.trim());
    report.osInputs.push({ mode, ...value, processExitObservedAt: Date.now() });
    if (expectedDesktop) {
      assert.equal(value.station, 'WinSta0');
      assert.equal(value.threadDesktop, expectedDesktop);
      assert.equal(value.inputDesktop, expectedDesktop);
    }
    if (value.ownedDownInjected && value.ownerVerified && value.leftHeldAfter) ownedDown = value;
    if (mode === 'up' && value.leftHeldAfter === false) ownedDown = undefined;
    return value;
  } catch (error) {
    if (error.stdout?.trim()) {
      const value = JSON.parse(error.stdout.trim());
      report.osInputs.push({ mode, ...value, processExitObservedAt: Date.now() });
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
  if (expectedDesktop) {
    assert.ok(desktopReceipt);
    await fs.writeFile(path.join(desktopReceipt, 'ready.tmp'), JSON.stringify({ pid: process.pid, desktop: expectedDesktop,
      mainWindow: report.windowIds.main, overlayWindow: report.windowIds.overlay }));
    await fs.rename(path.join(desktopReceipt, 'ready.tmp'), path.join(desktopReceipt, 'ready.json'));
    report.electronProcesses = app.getAppMetrics().map(({ pid, type, creationTime }) => ({ pid, type, creationTime }));
    for (const [window, color] of [[main, '#00ffff'], [overlay, '#ff00ff']]) {
      await window.webContents.executeJavaScript(`(() => {
        const marker = document.createElement('div');
        marker.style.cssText = 'position:fixed;left:4px;top:4px;width:14px;height:14px;background:${color};z-index:2147483647;pointer-events:none';
        document.body.append(marker);
      })()`);
    }
    const visible = (png, cyan) => {
      const pixels = nativeImage.createFromBuffer(png).toBitmap();
      let count = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] > 180 && (cyan ? pixels[index + 1] > 180 && pixels[index + 2] < 80
          : pixels[index + 1] < 80 && pixels[index + 2] > 180)) count++;
      }
      return count >= 8;
    };
    const mainCapture = (await main.webContents.capturePage()).toPNG();
    const overlayCapture = (await overlay.webContents.capturePage()).toPNG();
    report.renderEvidence = { coverage: 'compositor-output-not-all-process-threads',
      roleSource: 'Electron-app-metrics-self-reported', mainCaptureBytes: mainCapture.length,
      overlayCaptureBytes: overlayCapture.length, mainMarkerVisible: visible(mainCapture, true),
      overlayMarkerVisible: visible(overlayCapture, false), desktopMarkerSamples: 0 };
    assert.equal(report.renderEvidence.mainMarkerVisible, true);
    assert.equal(report.renderEvidence.overlayMarkerVisible, true);
    const renderDirectory = path.join(directory, 'release-render');
    await fs.mkdir(renderDirectory);
    await fs.writeFile(path.join(renderDirectory, 'main-render.png'), mainCapture);
    await fs.writeFile(path.join(renderDirectory, 'overlay-render.png'), overlayCapture);
    const stop = await recordDesktop(renderDirectory, (png) => {
      assert.ok(visible(png, true) && visible(png, false), 'Release fixture render markers missing from whole desktop.');
      report.renderEvidence.desktopMarkerSamples++;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    Object.assign(report.renderEvidence, await stop());
  }
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
