const assert = require('node:assert/strict');

function assertDesktopChain(report, desktop) {
  assert.equal(report.windowIds.owner, desktop.ownedPid);
  assert.equal(desktop.initialControllerThreadDesktop, 'Default');
  assert.equal(desktop.controllerThreadDesktop, 'Default');
  assert.equal(desktop.harnessObserverThreadDesktop, desktop.ownedDesktop);
  assert.equal(desktop.windowSeparation, true);
  assert.equal(desktop.defaultFixtureStayedAlive, true);
  assert.equal(desktop.defaultFixtureHeartbeatFresh, true);
  const metrics = report.electronProcesses;
  assert.ok(metrics.some(({ pid, type }) => pid === desktop.ownedPid && type === 'Browser'));
  assert.ok(metrics.some(({ type }) => type === 'GPU'));
  assert.ok(metrics.filter(({ type }) => type === 'Tab').length >= 2);
  const pids = new Set([...metrics.map(({ pid }) => pid),
    ...(report.helpers || []).map(({ pid }) => pid), ...report.osInputs.map(({ driverPid }) => driverPid)]);
  if (report.cleanupRelease) pids.add(report.cleanupRelease.driverPid);
  for (const pid of pids) {
    assert.ok(Number.isInteger(pid) && pid > 0, 'A tested desktop role lacks an actual PID.');
    const observation = desktop.descendantDesktopObservations.find((value) => value.pid === pid);
    assert.equal(observation?.status, 'verified-owned-job-member', `Desktop/Job inheritance not observed for PID ${pid}.`);
    assert.deepEqual(observation.threadDesktops, [desktop.ownedDesktop]);
    assert.ok(observation.threadObservations?.length > 0, `PID ${pid} lacks actual thread query receipts.`);
    for (const thread of observation.threadObservations) {
      assert.equal(thread.pid, pid);
      assert.ok(Number.isInteger(thread.tid) && thread.tid > 0);
      assert.equal(thread.api, 'GetUserObjectInformationW');
      assert.match(thread.rawHandle, /^[1-9][0-9]*$/);
      assert.equal(thread.win32Error, 0);
      assert.equal(thread.status, 'observed');
      assert.equal(thread.threadDesktop, desktop.ownedDesktop);
    }
  }
  if (report.startupRecovery) {
    const recovery = report.startupRecovery;
    const failed = report.helpers.find(({ pid }) => pid === recovery.failedPid);
    const recovered = report.helpers.find(({ pid }) => pid === recovery.recoveredPid);
    assert.ok(failed && recovered && failed !== recovered, 'Both startup helper generations must be retained.');
    assert.equal(failed.ownedStartupFailureInjected, true);
    assert.equal(failed.exit.at, recovery.failedExitAt);
    assert.ok(failed.closedAt <= recovered.startedAt);
    assert.equal(report.initialPointerRestarts, 1);
    assert.ok([recovery.injectedAt, recovery.failedExitAt, recovery.recoveredReadyAt, report.rootReadyAt]
      .every(Number.isFinite));
    assert.ok(recovery.injectedAt <= recovery.failedExitAt && recovery.failedExitAt <= recovery.recoveredReadyAt &&
      recovery.recoveredReadyAt <= report.rootReadyAt, 'Startup exit/recovery must precede actual root readiness.');
    assert.ok(desktop.descendantDesktopObservations.find(({ pid }) => pid === failed.pid).observedAt <= recovery.failedExitAt,
      'The exited startup generation needs durable pre-exit Job/desktop proof.');
  }
  for (const receipt of [...(report.nativeDesktopReceipts || []), ...report.osInputs,
    ...(report.cleanupRelease ? [report.cleanupRelease] : [])]) {
    assert.equal(receipt.station, 'WinSta0');
    assert.equal(receipt.threadDesktop, desktop.ownedDesktop);
    assert.equal(receipt.inputDesktop, desktop.ownedDesktop);
  }
}

module.exports = { assertDesktopChain };
