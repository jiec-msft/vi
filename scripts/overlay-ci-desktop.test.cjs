const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertDesktopChain, assertWrapperOutcome } = require('./overlay-ci-desktop.cjs');

test('accepts only the exact expected raw wrapper outcome', () => {
  for (const errors of [[], ['Owned child timed out.'], ['Owned child failed with exit code 1.']]) {
    assertWrapperOutcome({ errors }, errors);
  }
});
for (const error of ['Default desktop owned fixture heartbeat is stale.', 'Original restore failed.',
  'Owned job cleanup failed.', 'Close desktop handle failed.']) {
  test(`expected timeout cannot absorb ${error}`, () => {
    assert.throws(() => assertWrapperOutcome({ childOutcome: 'timeout',
      errors: ['Owned child timed out.', error] }, ['Owned child timed out.']),
    (failure) => failure.message.includes(error));
  });
  test(`expected negative exit cannot absorb ${error}`, () => {
    assert.throws(() => assertWrapperOutcome({ childOutcome: 'exit', childExitCode: 1,
      errors: ['Owned child failed with exit code 1.', error] }, ['Owned child failed with exit code 1.']),
    (failure) => failure.message.includes(error));
  });
}
test('rejects a missing wrapper outcome instead of inventing success', () => {
  assert.throws(() => assertWrapperOutcome({}), /lacks its raw errors/);
});

const birth = (pid) => `13300000000000000${pid}`;
const unknownThread = { pid: 1, tid: 101, api: 'GetThreadDesktop', rawHandle: '0',
  win32Error: 5, status: 'unobserved-not-desktop-proof', threadDesktop: null };
function member(pid) {
  return { pid, creationFileTime: birth(pid), processCreatedAt: 1000, observedAt: 1080, snapshotCompletedAt: 1090,
    specificJobMember: true, liveAtCompletion: true, membershipApi: 'IsProcessInJob',
    liveCheckedAt: 1091, liveCheckApi: 'WaitForSingleObject', liveCheckWaitState: 258, liveCheckWin32Error: 0,
    coverage: 'specific-job-process-identity-not-thread-desktop', status: 'verified-specific-job-process-identity',
    threadObservations: [{ ...unknownThread, pid }] };
}
function self(pid, role, desktop) {
  return { pid, role, creationFileTime: birth(pid), thread: 105, executionThread: 105, station: 'WinSta0',
    threadDesktop: desktop, inputDesktop: desktop, selfQueryComplete: true, queryStartedAt: 1100, queryCompletedAt: 1101,
    generation: 1, queryStartedTicks: '11000', queryCompletedTicks: '11010',
    monotonicFrequency: '10000000', monotonicClock: 'native-process-Stopwatch',
    coverage: 'self-execution-thread-not-all-process-threads' };
}
function readyEvent(at) {
  return { type: 'ready', at, readySequence: 1, receiveOrder: 1, receivedTicks: '20000',
    message: '{"type":"ready"}', monotonicClock: 'Node-process-hrtime-not-native-stopwatch' };
}
function emission(pid, generation = 1) {
  return { pid, role: 'overlay-pointer', creationFileTime: birth(pid), generation, executionThread: 105,
    readySequence: 1, messageBase64: Buffer.from('{"type":"ready"}').toString('base64'),
    writeApi: 'Console.WriteLine', writeComplete: true, writeStartedAt: 1110, writeCompletedAt: 1111,
    writeStartedTicks: '11100', writeCompletedTicks: '11110',
    monotonicFrequency: '10000000', monotonicClock: 'native-process-Stopwatch' };
}
function fixture() {
  const name = 'vi-ci-test';
  const report = { windowIds: { owner: 1, main: '11', overlay: '12' },
    electronProcesses: [{ pid: 1, type: 'Browser' }, { pid: 2, type: 'GPU' },
      { pid: 3, type: 'Tab' }, { pid: 4, type: 'Tab' }].map((value) => ({ ...value, creationTime: 1000 })),
    helpers: [{ pid: 5, role: 'overlay-pointer', generation: 1, startedAt: 1001, events: [readyEvent(1120)] }],
    nativeDesktopReceipts: [self(5, 'overlay-pointer', name)],
    nativeReadyReceipts: [emission(5)],
    osInputs: [{ ...self(6, 'os-mouse-driver', name), driverPid: 6, driverThread: 105,
      processExitObservedAt: 1200, targetEnumerationApi: 'EnumDesktopWindows', targetEnumeratedOnOwnedDesktop: true,
      targetWindow: '12', targetPid: 1, targetThread: 101 }],
    renderEvidence: { coverage: 'compositor-output-not-all-process-threads', roleSource: 'Electron-app-metrics-self-reported',
      mainMarkerVisible: true, overlayMarkerVisible: true, desktopMarkerSamples: 1, mainCaptureBytes: 1, overlayCaptureBytes: 1 } };
  const desktop = { ownedPid: 1, ownedDesktop: name, controllerPid: 99, initialControllerThreadDesktop: 'Default',
    controllerThreadDesktop: 'Default', controllerThreadQuery: { pid: 99, tid: 199, threadDesktop: 'Default',
      status: 'observed', win32Error: 0 }, restoredControllerThreadQuery: { pid: 99, tid: 199, threadDesktop: 'Default',
      status: 'observed', win32Error: 0 }, harnessObserverThreadDesktop: name, windowSeparation: true,
    defaultFixtureStayedAlive: true, defaultFixtureHeartbeatFresh: true, rootWindowsVerified: true,
    rootWindowQueryContext: { scope: 'window-desktop-association-not-all-root-threads', rootPid: 1,
      enumerationApi: 'EnumDesktopWindows', enumerated: true, enumerationError: 0, ownedDesktopHandleName: name,
      processTimesRead: true, processTimesError: 0, rootCreationFileTime: birth(1), callerTid: 199,
      waitState: 258, waitError: 0, exitCodeRead: true, exitCodeError: 0,
      currentThreadQuery: { pid: 99, tid: 199, status: 'observed', threadDesktop: name } },
    rootWindowSnapshotCompletedAt: 1700,
    rootWindowObservations: ['mainWindow', 'overlayWindow'].map((role, index) => ({
      role, window: String(11 + index), exists: true, visible: true, pid: 1, tid: 101,
      identityApi: 'GetWindowThreadProcessId', identityError: 0, enumeratedOnOwnedDesktop: true,
      coverage: 'window-desktop-association', rootCreationFileTime: birth(1), snapshotCompletedAt: 1690,
      threadQuery: { ...unknownThread } })),
    descendantDesktopObservations: [1, 2, 3, 4, 5, 6].map(member) };
  desktop.defaultPid = 8;
  desktop.rootWallLimitSeconds = 150;
  desktop.defaultHeartbeatIdentity = { protocol: 'vi-ci-immutable-heartbeat-v1', pid: 8,
    creationFileTime: birth(8), generation: 1, cadenceMilliseconds: 250, frameLimit: 720,
    lifetimeBound: 'existing-default-ready20-root-inclusive-deadline-and-job-cleanup10' };
  desktop.defaultHeartbeatSamples = ['before-owned-root', 'root-outcome-freshness-check',
    'after-original-restore-before-job-cleanup'].map((phase) => ({
    phase, protocol: 'vi-ci-immutable-heartbeat-v1', pid: 8, heartbeatPid: 8, creationFileTime: birth(8),
    heartbeatCreationFileTime: birth(8), generation: 1, heartbeatGeneration: 1, frameLimit: 720,
    cadenceMilliseconds: 250, heartbeatSequence: 1, frameCount: 1,
    heartbeatFile: `heartbeat-v1-8-${birth(8)}-g1-s000001.json`, heartbeatStatus: 'read-immutable-frame',
    heartbeatAt: 1750, sampleAt: 1800, ageMilliseconds: 50, freshnessLimitMilliseconds: 3000,
    processCreatedAt: 1000, snapshotCompletedAt: 1810, liveCheckedAt: 1811,
    processTimesRead: true, processTimesError: 0, membershipApi: 'IsProcessInJob', membershipRead: true,
    membershipError: 0, specificDefaultJobMember: true, liveCheckApi: 'WaitForSingleObject',
    liveCheckWaitState: 258, liveCheckWin32Error: 0, visibleWindowCount: 1 }));
  desktop.defaultHeartbeatCheck = desktop.defaultHeartbeatSamples[1];
  desktop.defaultFixtureExit = { pid: 8, creationFileTime: birth(8), processTimesRead: true,
    processTimesError: 0, exitedAt: 1900 };
  return { report, desktop };
}
test('accepts explicit role-specific proof while retaining inaccessible remote threads as nonproof', () => {
  const { report, desktop } = fixture();
  assertDesktopChain(report, desktop);
});
test('native monotonic diagnostics do not bypass the original Node UTC readiness gate', () => {
  const { report, desktop } = fixture();
  report.nativeDesktopReceipts[0].queryCompletedAt = 1126;
  report.nativeReadyReceipts[0].writeStartedAt = 1127;
  report.nativeReadyReceipts[0].writeCompletedAt = 1128;
  assert.throws(() => assertDesktopChain(report, desktop), /completed after observed readiness/);
});
for (const [label, change] of [
  ['unrelated root PID', (r) => { r.windowIds.owner = 99; }],
  ['missing precise window', (r, d) => { d.rootWindowObservations.pop(); }],
  ['window missing from desktop enumeration', (r, d) => { d.rootWindowObservations[0].enumeratedOnOwnedDesktop = false; }],
  ['wrong HWND identity', (r, d) => { d.rootWindowObservations[0].window = '999'; }],
  ['wrong root birth', (r, d) => { d.rootWindowObservations[0].rootCreationFileTime = birth(2); }],
  ['missing specific Job proof', (r, d) => { d.descendantDesktopObservations.pop(); }],
  ['self-name without specific Job membership', (r, d) => { d.descendantDesktopObservations[5].specificJobMember = false; }],
  ['process exited before snapshot completion', (r, d) => { d.descendantDesktopObservations[5].liveAtCompletion = false; }],
  ['exited remote thread inventory is not completed role proof', (r, d) => {
    d.descendantDesktopObservations[5].status = 'exited-before-completed-job-proof';
  }],
  ['missing post-completion live check', (r, d) => { delete d.descendantDesktopObservations[5].liveCheckedAt; }],
  ['live check before completion', (r, d) => { d.descendantDesktopObservations[5].liveCheckedAt = 1089; }],
  ['missing live wait state', (r, d) => { delete d.descendantDesktopObservations[5].liveCheckWaitState; }],
  ['failed live wait', (r, d) => { d.descendantDesktopObservations[5].liveCheckWaitState = 0xffffffff; }],
  ['live wait reports process exit', (r, d) => { d.descendantDesktopObservations[5].liveCheckWaitState = 0; }],
  ['failed live wait error', (r, d) => { d.descendantDesktopObservations[5].liveCheckWin32Error = 6; }],
  ['wrong lifetime API', (r, d) => { d.descendantDesktopObservations[5].liveCheckApi = 'GetExitCodeProcess'; }],
  ['live check after self-query start', (r, d) => { d.descendantDesktopObservations[5].liveCheckedAt = 1102; }],
  ['query start used as completion', (r, d) => { delete d.descendantDesktopObservations[5].snapshotCompletedAt; }],
  ['missing GPU', (r) => { r.electronProcesses = r.electronProcesses.filter((p) => p.type !== 'GPU'); }],
  ['metrics PID reuse', (r) => { r.electronProcesses[1].creationTime = 2000; }],
  ['role coverage overclaim', (r) => { r.electronProcesses[1].allThreadDesktop = true; }],
  ['Job falsely marked desktop verified', (r, d) => { d.descendantDesktopObservations[1].desktopVerified = true; }],
  ['render evidence missing', (r) => { r.renderEvidence.overlayMarkerVisible = false; }],
  ['unjoined native receipt', (r) => { r.nativeDesktopReceipts[0].pid = 99; }],
  ['native process birth mismatch', (r) => { r.nativeDesktopReceipts[0].creationFileTime = birth(99); }],
  ['native generation predates external birth', (r) => { r.helpers[0].startedAt = 900; }],
  ['partial self-query', (r) => { r.nativeDesktopReceipts[0].selfQueryComplete = false; }],
  ['wrong native execution thread', (r) => { r.nativeDesktopReceipts[0].executionThread = 999; }],
  ['default native thread', (r) => { r.nativeDesktopReceipts[0].threadDesktop = 'Default'; }],
  ['native query after observed readiness', (r) => { r.nativeDesktopReceipts[0].queryCompletedAt = 1121; }],
  ['missing native READY diagnostic', (r) => { r.nativeReadyReceipts = []; }],
  ['unjoined native READY diagnostic', (r) => { r.nativeReadyReceipts.push(emission(99)); }],
  ['duplicate native READY diagnostic', (r) => { r.nativeReadyReceipts.push(emission(5)); }],
  ['native READY birth mismatch', (r) => { r.nativeReadyReceipts[0].creationFileTime = birth(99); }],
  ['native READY generation mismatch', (r) => { r.nativeReadyReceipts[0].generation = 2; }],
  ['native self generation mismatch', (r) => { r.nativeDesktopReceipts[0].generation = 2; }],
  ['native READY execution thread mismatch', (r) => { r.nativeReadyReceipts[0].executionThread = 999; }],
  ['native READY message mismatch', (r) => { r.nativeReadyReceipts[0].messageBase64 = Buffer.from('{"type":"cancel"}').toString('base64'); }],
  ['native READY sequence mismatch', (r) => { r.nativeReadyReceipts[0].readySequence = 2; }],
  ['READY received sequence mismatch', (r) => { r.helpers[0].events[0].readySequence = 2; }],
  ['missing Node receive order', (r) => { delete r.helpers[0].events[0].receiveOrder; }],
  ['missing Node monotonic receive time', (r) => { delete r.helpers[0].events[0].receivedTicks; }],
  ['incomplete native READY write', (r) => { r.nativeReadyReceipts[0].writeComplete = false; }],
  ['missing native query monotonic completion', (r) => { delete r.nativeDesktopReceipts[0].queryCompletedTicks; }],
  ['query completed after actual READY write', (r) => { r.nativeDesktopReceipts[0].queryCompletedTicks = '11101'; }],
  ['READY write completed before start', (r) => { r.nativeReadyReceipts[0].writeCompletedTicks = '11099'; }],
  ['READY clock frequency mismatch', (r) => { r.nativeReadyReceipts[0].monotonicFrequency = '1000'; }],
  ['Node clock mislabeled native', (r) => { r.helpers[0].events[0].monotonicClock = 'native-process-Stopwatch'; }],
  ['changed active input desktop', (r) => { r.osInputs[0].inputDesktop = 'Default'; }],
  ['driver birth mismatch', (r) => { r.osInputs[0].creationFileTime = birth(99); }],
  ['driver query after observed exit', (r) => { r.osInputs[0].queryCompletedAt = 1300; }],
  ['wrong driver execution thread', (r) => { r.osInputs[0].executionThread = 999; }],
  ['wrong driver target window', (r) => { r.osInputs[0].targetWindow = '999'; }],
  ['driver target absent from owned enumeration', (r) => { r.osInputs[0].targetEnumeratedOnOwnedDesktop = false; }],
  ['connected wrong remote desktop', (r, d) => { d.rootWindowObservations[0].threadQuery.threadDesktop = 'Default'; }],
  ['wrong observer current thread', (r, d) => { d.rootWindowQueryContext.currentThreadQuery.tid = 999; }],
  ['stale Default heartbeat', (r, d) => { d.defaultFixtureHeartbeatFresh = false; }],
  ['missing immutable Default protocol', (r, d) => { delete d.defaultHeartbeatIdentity; }],
  ['wrong immutable Default process birth', (r, d) => { d.defaultHeartbeatSamples[0].heartbeatCreationFileTime = birth(99); }],
  ['wrong immutable Default generation', (r, d) => { d.defaultHeartbeatSamples[0].heartbeatGeneration = 2; }],
  ['missing completed immutable Default sample', (r, d) => { d.defaultHeartbeatSamples.length = 0; }],
  ['stale immutable Default sample', (r, d) => {
    Object.assign(d.defaultHeartbeatSamples[0], { sampleAt: 4750, ageMilliseconds: 3000, snapshotCompletedAt: 4760, liveCheckedAt: 4761 });
  }],
  ['immutable Default cap increased', (r, d) => { d.defaultHeartbeatIdentity.frameLimit++; }],
  ['immutable Default cadence relaxed', (r, d) => { d.defaultHeartbeatSamples[0].cadenceMilliseconds = 500; }],
  ['immutable Default sequence malformed', (r, d) => { d.defaultHeartbeatSamples[0].heartbeatSequence = '1'; }],
  ['immutable Default frame count gap', (r, d) => { d.defaultHeartbeatSamples[0].frameCount = 2; }],
  ['immutable Default filename mismatch', (r, d) => { d.defaultHeartbeatSamples[0].heartbeatFile = 'heartbeat.json'; }],
  ['immutable Default membership missing', (r, d) => { d.defaultHeartbeatSamples[0].specificDefaultJobMember = false; }],
  ['immutable Default exited live wait', (r, d) => { d.defaultHeartbeatSamples[0].liveCheckWaitState = 0; }],
  ['immutable Default failed live wait', (r, d) => { d.defaultHeartbeatSamples[0].liveCheckWaitState = 0xffffffff; }],
  ['immutable Default window missing', (r, d) => { d.defaultHeartbeatSamples[0].visibleWindowCount = 0; }],
  ['immutable Default exit birth mismatch', (r, d) => { d.defaultFixtureExit.creationFileTime = birth(99); }],
  ['immutable Default sample completed after exit', (r, d) => { d.defaultFixtureExit.exitedAt = 1810; }],
]) {
  test(`rejects ${label}`, () => {
    const { report, desktop } = fixture();
    change(report, desktop);
    assert.throws(() => assertDesktopChain(report, desktop));
  });
}
function startupFixture() {
  const { report, desktop } = fixture();
  Object.assign(report.helpers[0], { ownedStartupFailureInjected: true, exit: { at: 1500 }, closedAt: 1510 });
  report.helpers.push({ pid: 7, role: 'overlay-pointer', generation: 2, startedAt: 1520,
    events: [readyEvent(1580)] });
  report.initialPointerRestarts = 1;
  report.rootReadyAt = 1600;
  report.startupRecovery = { failedPid: 5, recoveredPid: 7, injectedAt: 1400, failedExitAt: 1500, recoveredReadyAt: 1580 };
  desktop.descendantDesktopObservations.push({ ...member(7), processCreatedAt: 1515,
    observedAt: 1560, snapshotCompletedAt: 1570, liveCheckedAt: 1571 });
  report.nativeDesktopReceipts.push({ ...self(7, 'overlay-pointer', desktop.ownedDesktop),
    generation: 2, queryStartedAt: 1572, queryCompletedAt: 1573 });
  report.nativeReadyReceipts.push({ ...emission(7, 2), writeStartedAt: 1574, writeCompletedAt: 1575 });
  return { report, desktop };
}
test('requires both completed generation proofs before the injected startup exit', () => {
  const { report, desktop } = startupFixture();
  assertDesktopChain(report, desktop);
});
for (const [label, change] of [
  ['lost first generation', (r) => { r.helpers.shift(); }],
  ['post-injection external completion', (r, d) => { d.descendantDesktopObservations[4].snapshotCompletedAt = 1401; }],
  ['post-injection external live check', (r, d) => { d.descendantDesktopObservations[4].liveCheckedAt = 1401; }],
  ['post-exit external completion', (r, d) => {
    Object.assign(d.descendantDesktopObservations[4], { snapshotCompletedAt: 1501, liveCheckedAt: 1502 });
  }],
  ['post-exit external live check', (r, d) => { d.descendantDesktopObservations[4].liveCheckedAt = 1501; }],
  ['post-injection self completion', (r) => { r.nativeDesktopReceipts[0].queryCompletedAt = 1401; }],
  ['post-exit self completion', (r) => { r.nativeDesktopReceipts[0].queryCompletedAt = 1501; }],
  ['stale self generation', (r) => { r.nativeDesktopReceipts[1].creationFileTime = birth(5); }],
  ['overlapping generations', (r) => { r.helpers[1].startedAt = 1500; }],
  ['recovery after root readiness', (r) => { r.startupRecovery.recoveredReadyAt = 1601; }],
]) {
  test(`rejects startup proof with ${label}`, () => {
    const { report, desktop } = startupFixture();
    change(report, desktop);
    assert.throws(() => assertDesktopChain(report, desktop));
  });
}
