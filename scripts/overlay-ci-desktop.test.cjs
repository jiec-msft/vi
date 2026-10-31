const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertDesktopChain } = require('./overlay-ci-desktop.cjs');

const birth = (pid) => `13300000000000000${pid}`;
const unknownThread = { pid: 1, tid: 101, api: 'GetThreadDesktop', rawHandle: '0',
  win32Error: 5, status: 'unobserved-not-desktop-proof', threadDesktop: null };
function member(pid) {
  return { pid, creationFileTime: birth(pid), processCreatedAt: 1000, observedAt: 1080, snapshotCompletedAt: 1090,
    specificJobMember: true, liveAtCompletion: true, membershipApi: 'IsProcessInJob',
    coverage: 'specific-job-process-identity-not-thread-desktop', status: 'verified-specific-job-process-identity',
    threadObservations: [{ ...unknownThread, pid }] };
}
function self(pid, role, desktop) {
  return { pid, role, creationFileTime: birth(pid), thread: 105, executionThread: 105, station: 'WinSta0',
    threadDesktop: desktop, inputDesktop: desktop, selfQueryComplete: true, queryStartedAt: 1100, queryCompletedAt: 1101,
    coverage: 'self-execution-thread-not-all-process-threads' };
}
function fixture() {
  const name = 'vi-ci-test';
  const report = { windowIds: { owner: 1, main: '11', overlay: '12' },
    electronProcesses: [{ pid: 1, type: 'Browser' }, { pid: 2, type: 'GPU' },
      { pid: 3, type: 'Tab' }, { pid: 4, type: 'Tab' }].map((value) => ({ ...value, creationTime: 1000 })),
    helpers: [{ pid: 5, role: 'overlay-pointer', generation: 1, startedAt: 1001, events: [{ type: 'ready', at: 1120 }] }],
    nativeDesktopReceipts: [self(5, 'overlay-pointer', name)],
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
  return { report, desktop };
}
test('accepts explicit role-specific proof while retaining inaccessible remote threads as nonproof', () => {
  const { report, desktop } = fixture();
  assertDesktopChain(report, desktop);
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
  ['changed active input desktop', (r) => { r.osInputs[0].inputDesktop = 'Default'; }],
  ['driver birth mismatch', (r) => { r.osInputs[0].creationFileTime = birth(99); }],
  ['driver query after observed exit', (r) => { r.osInputs[0].queryCompletedAt = 1300; }],
  ['wrong driver execution thread', (r) => { r.osInputs[0].executionThread = 999; }],
  ['wrong driver target window', (r) => { r.osInputs[0].targetWindow = '999'; }],
  ['driver target absent from owned enumeration', (r) => { r.osInputs[0].targetEnumeratedOnOwnedDesktop = false; }],
  ['connected wrong remote desktop', (r, d) => { d.rootWindowObservations[0].threadQuery.threadDesktop = 'Default'; }],
  ['wrong observer current thread', (r, d) => { d.rootWindowQueryContext.currentThreadQuery.tid = 999; }],
  ['stale Default heartbeat', (r, d) => { d.defaultFixtureHeartbeatFresh = false; }],
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
    events: [{ type: 'ready', at: 1580 }] });
  report.initialPointerRestarts = 1;
  report.rootReadyAt = 1600;
  report.startupRecovery = { failedPid: 5, recoveredPid: 7, injectedAt: 1400, failedExitAt: 1500, recoveredReadyAt: 1580 };
  desktop.descendantDesktopObservations.push({ ...member(7), processCreatedAt: 1515,
    observedAt: 1560, snapshotCompletedAt: 1570 });
  report.nativeDesktopReceipts.push({ ...self(7, 'overlay-pointer', desktop.ownedDesktop),
    queryStartedAt: 1572, queryCompletedAt: 1573 });
  return { report, desktop };
}
test('requires both completed generation proofs before the injected startup exit', () => {
  const { report, desktop } = startupFixture();
  assertDesktopChain(report, desktop);
});
for (const [label, change] of [
  ['lost first generation', (r) => { r.helpers.shift(); }],
  ['post-injection external completion', (r, d) => { d.descendantDesktopObservations[4].snapshotCompletedAt = 1401; }],
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
