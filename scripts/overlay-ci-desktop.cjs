const assert = require('node:assert/strict');

function finiteTime(value) {
  assert.ok(Number.isFinite(value) && value > 0, 'A completed proof lacks its actual timestamp.');
  return value;
}
function assertCoverage(value, coverage) {
  assert.equal(value.coverage, coverage);
  assert.notEqual(value.allThreadDesktop, true, 'Role-specific evidence cannot claim every process thread.');
  assert.notEqual(value.desktopVerified, true, 'Job membership alone is not desktop proof.');
}
function assertSelfThread(receipt, desktop) {
  assert.equal(receipt.selfQueryComplete, true);
  assert.ok(Number.isInteger(receipt.thread ?? receipt.driverThread) && (receipt.thread ?? receipt.driverThread) > 0);
  assert.equal(receipt.executionThread, receipt.thread ?? receipt.driverThread);
  assert.equal(receipt.station, 'WinSta0');
  assert.equal(receipt.threadDesktop, desktop.ownedDesktop);
  assert.equal(receipt.inputDesktop, desktop.ownedDesktop);
  assertCoverage(receipt, 'self-execution-thread-not-all-process-threads');
  assert.ok(finiteTime(receipt.queryStartedAt) <= finiteTime(receipt.queryCompletedAt));
}
function assertDesktopChain(report, desktop) {
  assert.equal(report.windowIds.owner, desktop.ownedPid);
  assert.equal(desktop.initialControllerThreadDesktop, 'Default');
  assert.equal(desktop.controllerThreadDesktop, 'Default');
  const controller = desktop.controllerThreadQuery;
  assert.equal(controller?.pid, desktop.controllerPid);
  assert.equal(controller.status, 'observed');
  assert.equal(controller.threadDesktop, 'Default');
  assert.equal(controller.win32Error, 0);
  assert.equal(desktop.restoredControllerThreadQuery?.tid, controller.tid);
  assert.equal(desktop.restoredControllerThreadQuery.pid, desktop.controllerPid);
  assert.equal(desktop.restoredControllerThreadQuery.status, 'observed');
  assert.equal(desktop.restoredControllerThreadQuery.threadDesktop, 'Default');
  assert.equal(desktop.harnessObserverThreadDesktop, desktop.ownedDesktop);
  assert.equal(desktop.windowSeparation, true);
  assert.equal(desktop.defaultFixtureStayedAlive, true);
  assert.equal(desktop.defaultFixtureHeartbeatFresh, true);
  const observations = desktop.descendantDesktopObservations;
  function member(pid, birth) {
    assert.ok(Number.isInteger(pid) && pid > 0, 'A required role lacks an actual PID.');
    assert.match(birth, /^[1-9][0-9]+$/, 'A required role lacks a process creation identity.');
    const observation = observations.find((value) => value.pid === pid && value.creationFileTime === birth);
    assert.equal(observation?.status, 'verified-specific-job-process-identity', `No completed specific Job proof for PID ${pid}/${birth}.`);
    assert.equal(observation.membershipApi, 'IsProcessInJob');
    assert.equal(observation.specificJobMember, true);
    assert.equal(observation.liveAtCompletion, true);
    assertCoverage(observation, 'specific-job-process-identity-not-thread-desktop');
    assert.ok(finiteTime(observation.processCreatedAt) <= finiteTime(observation.observedAt) &&
      observation.observedAt <= finiteTime(observation.snapshotCompletedAt));
    for (const diagnostic of observation.threadObservations || []) {
      if (diagnostic.threadDesktop != null) assert.equal(diagnostic.threadDesktop, desktop.ownedDesktop);
    }
    return observation;
  }
  assert.equal(desktop.rootWindowsVerified, true);
  const context = desktop.rootWindowQueryContext;
  assert.equal(context?.scope, 'window-desktop-association-not-all-root-threads');
  assert.equal(context.rootPid, desktop.ownedPid);
  assert.equal(context.enumerationApi, 'EnumDesktopWindows');
  assert.equal(context.enumerated, true);
  assert.equal(context.enumerationError, 0);
  assert.equal(context.ownedDesktopHandleName, desktop.ownedDesktop);
  assert.equal(context.processTimesRead, true);
  assert.equal(context.processTimesError, 0);
  assert.equal(context.waitState, 258);
  assert.equal(context.waitError, 0);
  assert.equal(context.exitCodeRead, true);
  assert.equal(context.exitCodeError, 0);
  assert.equal(context.currentThreadQuery.status, 'observed');
  assert.equal(context.currentThreadQuery.threadDesktop, desktop.ownedDesktop);
  assert.equal(context.currentThreadQuery.pid, desktop.controllerPid);
  assert.equal(context.currentThreadQuery.tid, context.callerTid);
  const root = member(desktop.ownedPid, context.rootCreationFileTime);
  assert.ok(root.snapshotCompletedAt <= finiteTime(desktop.rootWindowSnapshotCompletedAt));
  assert.deepEqual(desktop.rootWindowObservations.map(({ role }) => role), ['mainWindow', 'overlayWindow']);
  for (const window of desktop.rootWindowObservations) {
    assertCoverage(window, 'window-desktop-association');
    assert.equal(window.window, report.windowIds[window.role === 'mainWindow' ? 'main' : 'overlay']);
    assert.equal(window.rootCreationFileTime, root.creationFileTime);
    assert.equal(window.exists, true);
    assert.equal(window.visible, true);
    assert.equal(window.pid, desktop.ownedPid);
    assert.ok(Number.isInteger(window.tid) && window.tid > 0);
    assert.equal(window.identityApi, 'GetWindowThreadProcessId');
    assert.equal(window.identityError, 0);
    assert.equal(window.enumeratedOnOwnedDesktop, true);
    assert.ok(finiteTime(window.snapshotCompletedAt) <= desktop.rootWindowSnapshotCompletedAt);
    if (window.threadQuery?.threadDesktop != null) {
      assert.equal(window.threadQuery.threadDesktop, desktop.ownedDesktop);
      assert.equal(window.threadQuery.pid, window.pid);
      assert.equal(window.threadQuery.tid, window.tid);
    }
  }
  const metrics = report.electronProcesses;
  assert.ok(metrics.some(({ pid, type }) => pid === desktop.ownedPid && type === 'Browser'));
  assert.ok(metrics.some(({ type }) => type === 'GPU'));
  assert.ok(metrics.filter(({ type }) => type === 'Tab').length >= 2);
  for (const metric of metrics) {
    const matches = observations.filter((value) => value.pid === metric.pid &&
      value.status === 'verified-specific-job-process-identity' &&
      Number.isFinite(metric.creationTime) && Math.abs(value.processCreatedAt - metric.creationTime) < 1);
    assert.equal(matches.length, 1, 'Electron metrics role/birth must match exactly one external Job generation.');
    member(metric.pid, matches[0].creationFileTime);
    assert.notEqual(metric.allThreadDesktop, true);
    assert.notEqual(metric.desktopVerified, true);
  }
  const render = report.renderEvidence;
  assertCoverage(render, 'compositor-output-not-all-process-threads');
  assert.equal(render.roleSource, 'Electron-app-metrics-self-reported');
  assert.equal(render.mainMarkerVisible, true);
  assert.equal(render.overlayMarkerVisible, true);
  assert.ok(render.desktopMarkerSamples > 0);
  assert.ok(render.mainCaptureBytes > 0 && render.overlayCaptureBytes > 0);

  const receipts = report.nativeDesktopReceipts || [];
  const helpers = report.helpers || [];
  for (const helper of helpers) {
    const matching = receipts.filter((value) => value.pid === helper.pid && value.role === helper.role);
    assert.equal(matching.length, 1, 'Each required helper generation needs its own execution receipt.');
    const receipt = matching[0];
    assertSelfThread(receipt, desktop);
    const job = member(helper.pid, receipt.creationFileTime);
    assert.ok(job.processCreatedAt <= helper.startedAt);
    assert.ok(Number.isInteger(helper.generation) && helper.generation > 0);
    assert.ok(helpers.filter((value) => value.role === helper.role && value.generation === helper.generation).length === 1);
    const next = helpers.find((value) => value.role === helper.role && value.generation === helper.generation + 1);
    if (next) assert.ok(helper.closedAt <= next.startedAt, 'Helper generations must not overlap.');
    const ready = helper.events.find(({ type }) => type === 'ready');
    assert.ok(ready, 'Required helper never reached readiness.');
    assert.ok(job.snapshotCompletedAt <= receipt.queryStartedAt &&
      finiteTime(helper.startedAt) <= receipt.queryCompletedAt && receipt.queryCompletedAt <= finiteTime(ready.at));
    if (helper.exit) assert.ok(job.snapshotCompletedAt <= helper.exit.at && receipt.queryCompletedAt <= helper.exit.at);
  }
  assert.equal(receipts.length, helpers.length, 'Unjoined native receipts cannot stand in for required roles.');
  for (const receipt of [...report.osInputs, ...(report.cleanupRelease ? [report.cleanupRelease] : [])]) {
    assert.equal(receipt.role, 'os-mouse-driver');
    assertSelfThread(receipt, desktop);
    const job = member(receipt.driverPid, receipt.creationFileTime);
    assert.ok(job.snapshotCompletedAt <= receipt.queryStartedAt &&
      receipt.queryCompletedAt <= finiteTime(receipt.processExitObservedAt));
    assert.ok(job.processCreatedAt <= receipt.queryStartedAt);
    assert.equal(receipt.targetEnumerationApi, 'EnumDesktopWindows');
    assert.equal(receipt.targetEnumeratedOnOwnedDesktop, true);
    assert.equal(receipt.targetWindow, report.windowIds.overlay);
    assert.equal(receipt.targetPid, desktop.ownedPid);
    assert.ok(Number.isInteger(receipt.targetThread) && receipt.targetThread > 0);
  }
  if (report.startupRecovery) {
    const recovery = report.startupRecovery;
    const failed = helpers.find(({ pid }) => pid === recovery.failedPid);
    const recovered = helpers.find(({ pid }) => pid === recovery.recoveredPid);
    assert.ok(failed && recovered && failed !== recovered);
    assert.equal(failed.ownedStartupFailureInjected, true);
    assert.equal(failed.exit.at, recovery.failedExitAt);
    assert.equal(recovered.generation, failed.generation + 1);
    assert.equal(report.initialPointerRestarts, 1);
    const receipt = receipts.find(({ pid }) => pid === failed.pid);
    const job = member(failed.pid, receipt.creationFileTime);
    assert.ok(job.snapshotCompletedAt < finiteTime(recovery.injectedAt) &&
      receipt.queryCompletedAt < recovery.injectedAt, 'Both completed startup proofs must precede the injected exit.');
    assert.ok(recovery.injectedAt <= recovery.failedExitAt &&
      recovery.failedExitAt <= finiteTime(recovery.recoveredReadyAt) &&
      recovery.recoveredReadyAt <= finiteTime(report.rootReadyAt));
  }
}

module.exports = { assertDesktopChain };
