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
function ticks(value) {
  assert.match(value, /^[1-9][0-9]*$/, 'A native readiness diagnostic lacks its monotonic sample.');
  return BigInt(value);
}
function assertReadyDiagnostics(helper, receipt, emissions) {
  assert.equal(receipt.requestId, helper.requestId);
  assert.equal(receipt.requestSequence, helper.requestSequence);
  assert.equal(receipt.generation, helper.generation);
  assert.equal(receipt.monotonicClock, 'native-process-Stopwatch');
  assert.ok(ticks(receipt.monotonicFrequency) > 0n);
  assert.ok(ticks(receipt.queryStartedTicks) <= ticks(receipt.queryCompletedTicks));
  if (helper.role !== 'overlay-pointer') return;
  const readyEvents = helper.events.filter(({ type }) => type === 'ready');
  const matched = emissions.filter((value) => value.pid === helper.pid && value.role === helper.role);
  assert.equal(matched.length, readyEvents.length, 'Each exact pointer READY needs its own native write diagnostic.');
  let previousReceiveOrder = 0, previousReceiveTicks = 0n, previousWriteTicks = 0n;
  for (const [index, event] of readyEvents.entries()) {
    const sequence = index + 1;
    assert.equal(event.readySequence, sequence);
    assert.equal(event.message, '{"type":"ready"}');
    assert.equal(event.monotonicClock, 'Node-process-hrtime-not-native-stopwatch');
    assert.ok(Number.isInteger(event.receiveOrder) && event.receiveOrder > previousReceiveOrder);
    assert.ok(ticks(event.receivedTicks) > previousReceiveTicks);
    previousReceiveOrder = event.receiveOrder;
    previousReceiveTicks = ticks(event.receivedTicks);
    const matches = matched.filter((value) => value.readySequence === sequence);
    assert.equal(matches.length, 1, 'READY sequence must match one immutable native emission.');
    const emission = matches[0];
    assert.equal(emission.creationFileTime, receipt.creationFileTime);
    assert.equal(emission.generation, helper.generation);
    assert.equal(emission.requestId, helper.requestId);
    assert.equal(emission.requestSequence, helper.requestSequence);
    assert.equal(emission.executionThread, receipt.executionThread);
    assert.equal(emission.messageBase64, Buffer.from(event.message).toString('base64'));
    assert.equal(emission.writeApi, 'Console.WriteLine');
    assert.equal(emission.writeComplete, true);
    assert.equal(emission.monotonicClock, receipt.monotonicClock);
    assert.equal(emission.monotonicFrequency, receipt.monotonicFrequency);
    finiteTime(emission.writeStartedAt);
    finiteTime(emission.writeCompletedAt);
    assert.ok(ticks(receipt.queryCompletedTicks) <= ticks(emission.writeStartedTicks) &&
      previousWriteTicks <= ticks(emission.writeStartedTicks) &&
      ticks(emission.writeStartedTicks) <= ticks(emission.writeCompletedTicks),
    `Native query/READY monotonic ordering failed: ${JSON.stringify({ receipt, emission, event })}`);
    previousWriteTicks = ticks(emission.writeCompletedTicks);
  }
}
function assertSpawnDiagnostics(helper, owner) {
  assert.equal(helper.callerPid, owner);
  assert.ok(Number.isInteger(helper.requestSequence) && helper.requestSequence > 0);
  assert.equal(helper.requestId, `${owner}-${helper.requestSequence}-${helper.role}-${helper.generation}`);
  assert.equal(helper.returnedPid, helper.pid);
  assert.equal(helper.spawnClock, 'Node-process-hrtime');
  assert.equal(helper.startedAtClock, 'Node-Date.now-not-native-FILETIME');
  assert.equal(helper.startedAtMeaning, 'observer-after-synchronous-spawn-return-before-spawn-event');
  finiteTime(helper.spawnStartedAt);
  finiteTime(helper.spawnReturnedAt);
  finiteTime(helper.spawnObservedAt);
  assert.ok(ticks(helper.spawnStartedTicks) <= ticks(helper.spawnReturnedTicks) &&
    ticks(helper.spawnReturnedTicks) <= ticks(helper.helperStartedTicks) &&
    ticks(helper.helperStartedTicks) <= ticks(helper.spawnObservedTicks));
  for (const ready of helper.events.filter(({ type }) => type === 'ready'))
    assert.ok(ticks(helper.spawnObservedTicks) <= ticks(ready.receivedTicks));
}
function assertWrapperOutcome(desktop, expectedErrors = []) {
  assert.ok(Array.isArray(desktop.errors), 'Owned desktop wrapper lacks its raw errors.');
  assert.deepEqual(desktop.errors, expectedErrors,
    `Owned desktop wrapper outcome failed: ${JSON.stringify({ childOutcome: desktop.childOutcome,
      childExitCode: desktop.childExitCode, errors: desktop.errors, defaultHeartbeatCheck: desktop.defaultHeartbeatCheck })}`);
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
  const defaultIdentity = desktop.defaultHeartbeatIdentity;
  assert.equal(defaultIdentity?.protocol, 'vi-ci-immutable-heartbeat-v1');
  assert.equal(defaultIdentity.pid, desktop.defaultPid);
  assert.notEqual(desktop.defaultPid, desktop.ownedPid);
  assert.match(defaultIdentity.creationFileTime, /^[1-9][0-9]+$/);
  assert.equal(defaultIdentity.generation, 1);
  assert.equal(defaultIdentity.cadenceMilliseconds, 250);
  assert.ok([35, 60, 150].includes(desktop.rootWallLimitSeconds));
  assert.equal(defaultIdentity.frameLimit, (20 + desktop.rootWallLimitSeconds + 10) * 4);
  assert.equal(defaultIdentity.lifetimeBound, 'existing-default-ready20-root-inclusive-deadline-and-job-cleanup10');
  const defaultSamples = desktop.defaultHeartbeatSamples;
  assert.ok(Array.isArray(defaultSamples) && defaultSamples.length >= 3 && defaultSamples.length <= 183);
  assert.equal(defaultSamples[0].phase, 'before-owned-root');
  assert.equal(defaultSamples.at(-1).phase, 'after-original-restore-before-job-cleanup');
  let previousDefaultSequence = 0;
  for (const sample of defaultSamples) {
    assert.equal(sample.protocol, defaultIdentity.protocol);
    assert.equal(sample.pid, defaultIdentity.pid);
    assert.equal(sample.heartbeatPid, defaultIdentity.pid);
    assert.equal(sample.creationFileTime, defaultIdentity.creationFileTime);
    assert.equal(sample.heartbeatCreationFileTime, defaultIdentity.creationFileTime);
    assert.equal(sample.generation, defaultIdentity.generation);
    assert.equal(sample.heartbeatGeneration, defaultIdentity.generation);
    assert.equal(sample.frameLimit, defaultIdentity.frameLimit);
    assert.equal(sample.cadenceMilliseconds, 250);
    assert.ok(Number.isInteger(sample.heartbeatSequence) && sample.heartbeatSequence > 0 &&
      sample.heartbeatSequence >= previousDefaultSequence && sample.heartbeatSequence <= sample.frameLimit);
    assert.equal(sample.frameCount, sample.heartbeatSequence);
    assert.equal(sample.heartbeatFile, `heartbeat-v1-${sample.pid}-${sample.creationFileTime}-g1-s${String(sample.heartbeatSequence).padStart(6, '0')}.json`);
    previousDefaultSequence = sample.heartbeatSequence;
    assert.equal(sample.heartbeatStatus, 'read-immutable-frame');
    assert.equal(sample.ageMilliseconds, finiteTime(sample.sampleAt) - finiteTime(sample.heartbeatAt));
    assert.equal(sample.freshnessLimitMilliseconds, 3000);
    assert.ok(sample.ageMilliseconds < 3000, 'Latest immutable Default heartbeat is stale.');
    assert.equal(sample.processTimesRead, true);
    assert.equal(sample.processTimesError, 0);
    assert.equal(sample.membershipApi, 'IsProcessInJob');
    assert.equal(sample.membershipRead, true);
    assert.equal(sample.membershipError, 0);
    assert.equal(sample.specificDefaultJobMember, true);
    assert.equal(sample.liveCheckApi, 'WaitForSingleObject');
    assert.equal(sample.liveCheckWaitState, 258);
    assert.equal(sample.liveCheckWin32Error, 0);
    assert.ok(sample.visibleWindowCount > 0);
    assert.ok(finiteTime(sample.processCreatedAt) <= sample.sampleAt &&
      sample.sampleAt <= finiteTime(sample.snapshotCompletedAt) &&
      sample.snapshotCompletedAt <= finiteTime(sample.liveCheckedAt));
    assert.notEqual(sample.allThreadDesktop, true);
    assert.notEqual(sample.desktopVerified, true);
  }
  assert.ok(defaultSamples.includes(desktop.defaultHeartbeatCheck) ||
    defaultSamples.some((sample) => sample.phase === 'root-outcome-freshness-check' &&
      JSON.stringify(sample) === JSON.stringify(desktop.defaultHeartbeatCheck)));
  assert.equal(desktop.defaultFixtureExit?.pid, defaultIdentity.pid);
  assert.equal(desktop.defaultFixtureExit.creationFileTime, defaultIdentity.creationFileTime);
  assert.equal(desktop.defaultFixtureExit.processTimesRead, true);
  assert.equal(desktop.defaultFixtureExit.processTimesError, 0);
  assert.ok(finiteTime(desktop.defaultFixtureExit.exitedAt) >= defaultSamples.at(-1).liveCheckedAt);
  const observations = desktop.descendantDesktopObservations;
  function member(pid, birth) {
    assert.ok(Number.isInteger(pid) && pid > 0, 'A required role lacks an actual PID.');
    assert.match(birth, /^[1-9][0-9]+$/, 'A required role lacks a process creation identity.');
    const observation = observations.find((value) => value.pid === pid && value.creationFileTime === birth);
    assert.equal(observation?.status, 'verified-specific-job-process-identity', `No completed specific Job proof for PID ${pid}/${birth}.`);
    assert.equal(observation.membershipApi, 'IsProcessInJob');
    assert.equal(observation.specificJobMember, true);
    assert.equal(observation.liveAtCompletion, true);
    assert.equal(observation.liveCheckApi, 'WaitForSingleObject');
    assert.equal(observation.liveCheckWaitState, 258);
    assert.equal(observation.liveCheckWin32Error, 0);
    assert.equal(observation.processCreationApi, 'GetProcessTimes');
    assert.equal(observation.processCreationClock, 'Win32-FILETIME-not-Node-Date.now');
    assertCoverage(observation, 'specific-job-process-identity-not-thread-desktop');
    assert.ok(finiteTime(observation.processCreatedAt) <= finiteTime(observation.observedAt) &&
      observation.observedAt <= finiteTime(observation.snapshotCompletedAt) &&
      observation.snapshotCompletedAt <= finiteTime(observation.liveCheckedAt));
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
  assert.ok(root.liveCheckedAt <= finiteTime(desktop.rootWindowSnapshotCompletedAt));
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
  let previousRequestSequence = 0;
  for (const helper of helpers) {
    assertSpawnDiagnostics(helper, desktop.ownedPid);
    assert.ok(helper.requestSequence > previousRequestSequence, 'Spawn requests must preserve their actual call order.');
    previousRequestSequence = helper.requestSequence;
    const matching = receipts.filter((value) => value.pid === helper.pid && value.role === helper.role);
    assert.equal(matching.length, 1, 'Each required helper generation needs its own execution receipt.');
    const receipt = matching[0];
    assertSelfThread(receipt, desktop);
    const job = member(helper.pid, receipt.creationFileTime);
    assert.ok(Number.isInteger(helper.generation) && helper.generation > 0);
    assert.ok(helpers.filter((value) => value.role === helper.role && value.generation === helper.generation).length === 1);
    const next = helpers.find((value) => value.role === helper.role && value.generation === helper.generation + 1);
    if (next) assert.ok(helper.closedAt <= next.startedAt, 'Helper generations must not overlap.');
    const ready = helper.events.find(({ type }) => type === 'ready');
    assert.ok(ready, 'Required helper never reached readiness.');
    assertReadyDiagnostics(helper, receipt, report.nativeReadyReceipts || []);
    const chronology = JSON.stringify({ pid: helper.pid, role: helper.role, generation: helper.generation,
      creationFileTime: receipt.creationFileTime, jobCompletedAt: job.snapshotCompletedAt,
      processCreatedAt: job.processCreatedAt, processCreationClock: job.processCreationClock,
      helperStartedAt: helper.startedAt, helperStartedClock: helper.startedAtClock,
      helperStartedTicks: helper.helperStartedTicks, helperStartedMeaning: helper.startedAtMeaning,
      spawn: { requestId: helper.requestId, requestSequence: helper.requestSequence, callerPid: helper.callerPid,
        returnedPid: helper.returnedPid, startedAt: helper.spawnStartedAt, startedTicks: helper.spawnStartedTicks,
        returnedAt: helper.spawnReturnedAt, returnedTicks: helper.spawnReturnedTicks,
        observedAt: helper.spawnObservedAt, observedTicks: helper.spawnObservedTicks, clock: helper.spawnClock },
      liveCheckedAt: job.liveCheckedAt, queryStartedAt: receipt.queryStartedAt,
      queryCompletedAt: receipt.queryCompletedAt, queryCompletedTicks: receipt.queryCompletedTicks,
      ready, nativeReady: (report.nativeReadyReceipts || []).filter((value) =>
        value.pid === helper.pid && value.role === helper.role) });
    assert.ok(job.processCreatedAt <= helper.startedAt, `Native birth/Node original helper start comparison failed: ${chronology}`);
    assert.ok(job.liveCheckedAt <= receipt.queryStartedAt, `Native self-query predates completed Job/live proof: ${chronology}`);
    assert.ok(finiteTime(helper.startedAt) <= receipt.queryCompletedAt);
    assert.ok(receipt.queryCompletedAt <= finiteTime(ready.at), `Native self-query completed after observed readiness: ${chronology}`);
    if (helper.exit) assert.ok(job.liveCheckedAt <= helper.exit.at && receipt.queryCompletedAt <= helper.exit.at);
  }
  assert.equal(receipts.length, helpers.length, 'Unjoined native receipts cannot stand in for required roles.');
  assert.equal((report.nativeReadyReceipts || []).length,
    helpers.filter(({ role }) => role === 'overlay-pointer')
      .reduce((count, helper) => count + helper.events.filter(({ type }) => type === 'ready').length, 0),
    'Unjoined READY diagnostics cannot stand in for required generations.');
  for (const receipt of [...report.osInputs, ...(report.cleanupRelease ? [report.cleanupRelease] : [])]) {
    assert.equal(receipt.role, 'os-mouse-driver');
    assertSelfThread(receipt, desktop);
    const job = member(receipt.driverPid, receipt.creationFileTime);
    assert.ok(job.liveCheckedAt <= receipt.queryStartedAt &&
      receipt.queryCompletedAt <= finiteTime(receipt.processExitObservedAt),
    `Driver proof chronology failed: ${JSON.stringify({ pid: receipt.driverPid, creationFileTime: receipt.creationFileTime,
      jobCompletedAt: job.snapshotCompletedAt, liveCheckedAt: job.liveCheckedAt, queryStartedAt: receipt.queryStartedAt,
      queryCompletedAt: receipt.queryCompletedAt, processExitObservedAt: receipt.processExitObservedAt })}`);
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
    assert.ok(job.liveCheckedAt < finiteTime(recovery.injectedAt) &&
      receipt.queryCompletedAt < recovery.injectedAt, 'Both completed startup proofs must precede the injected exit.');
    assert.ok(recovery.injectedAt <= recovery.failedExitAt &&
      recovery.failedExitAt <= finiteTime(recovery.recoveredReadyAt) &&
      recovery.recoveredReadyAt <= finiteTime(report.rootReadyAt));
  }
}

module.exports = { assertDesktopChain, assertWrapperOutcome };
