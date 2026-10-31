const assert = require('node:assert/strict');

function assertDesktopChain(report, desktop) {
  assert.equal(report.windowIds.owner, desktop.ownedPid);
  assert.equal(desktop.initialControllerThreadDesktop, 'Default');
  assert.equal(desktop.controllerThreadDesktop, desktop.ownedDesktop);
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
  }
  for (const receipt of [...(report.nativeDesktopReceipts || []), ...report.osInputs,
    ...(report.cleanupRelease ? [report.cleanupRelease] : [])]) {
    assert.equal(receipt.station, 'WinSta0');
    assert.equal(receipt.threadDesktop, desktop.ownedDesktop);
    assert.equal(receipt.inputDesktop, desktop.ownedDesktop);
  }
}

module.exports = { assertDesktopChain };
