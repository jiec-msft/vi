const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertDesktopChain } = require('./overlay-ci-desktop.cjs');

function observedThread(pid, name) {
  return { pid, tid: pid + 100, api: 'GetUserObjectInformationW', rawHandle: '123',
    win32Error: 0, status: 'observed', threadDesktop: name };
}
function fixture() {
  const name = 'vi-ci-test';
  const report = { windowIds: { owner: 1 },
    electronProcesses: [{ pid: 1, type: 'Browser' }, { pid: 2, type: 'GPU' },
      { pid: 3, type: 'Tab' }, { pid: 4, type: 'Tab' }],
    helpers: [{ pid: 5 }], nativeDesktopReceipts: [{ station: 'WinSta0', threadDesktop: name, inputDesktop: name }],
    osInputs: [{ driverPid: 6, station: 'WinSta0', threadDesktop: name, inputDesktop: name }] };
  const desktop = { ownedPid: 1, ownedDesktop: name, initialControllerThreadDesktop: 'Default',
    controllerThreadDesktop: 'Default', harnessObserverThreadDesktop: name, windowSeparation: true,
    defaultFixtureStayedAlive: true, defaultFixtureHeartbeatFresh: true,
    descendantDesktopObservations: [1, 2, 3, 4, 5, 6].map((pid) =>
      ({ pid, threadDesktops: [name], threadObservations: [observedThread(pid, name)],
        status: 'verified-owned-job-member' })) };
  return { report, desktop };
}
test('requires actual root, renderer, GPU, native helper and OS driver Job/desktop observations', () => {
  const { report, desktop } = fixture();
  assertDesktopChain(report, desktop);
});
for (const [label, change] of [
  ['unrelated visible window PID', (r) => { r.windowIds.owner = 99; }],
  ['missing GPU', (r) => { r.electronProcesses = r.electronProcesses.filter((p) => p.type !== 'GPU'); }],
  ['unobserved short-lived driver', (r, d) => { d.descendantDesktopObservations.at(-1).status = 'exited-before-observation-not-desktop-proof'; }],
  ['pending startup query', (r, d) => { d.descendantDesktopObservations[0].status = 'unobserved-not-desktop-proof'; }],
  ['missing actual thread receipts', (r, d) => { delete d.descendantDesktopObservations[0].threadObservations; }],
  ['NULL handle labeled verified', (r, d) => { d.descendantDesktopObservations[0].threadObservations[0].rawHandle = '0'; }],
  ['failed USER name query labeled verified', (r, d) => { d.descendantDesktopObservations[0].threadObservations[0].win32Error = 6; }],
  ['partly unobserved thread snapshot', (r, d) => { d.descendantDesktopObservations[0].threadObservations.push({
    pid: 1, tid: 200, api: 'GetThreadDesktop', rawHandle: '0', win32Error: 87,
    status: 'unobserved-not-desktop-proof', threadDesktop: null }); }],
  ['connected wrong-desktop thread', (r, d) => { d.descendantDesktopObservations[0].threadObservations[0].threadDesktop = 'Default'; }],
  ['default desktop native helper', (r, d) => { d.descendantDesktopObservations[4].threadDesktops = ['Default']; }],
  ['changed active input desktop', (r) => { r.osInputs[0].inputDesktop = 'Default'; }],
  ['stale default heartbeat', (r, d) => { d.defaultFixtureHeartbeatFresh = false; }],
  ['unconnected observer thread', (r, d) => { d.harnessObserverThreadDesktop = 'Default'; }],
]) {
  test(`rejects ${label} instead of accepting declared desktop names`, () => {
    const { report, desktop } = fixture();
    change(report, desktop);
    assert.throws(() => assertDesktopChain(report, desktop));
  });
}
function startupFixture() {
  const { report, desktop } = fixture();
  report.helpers = [{ pid: 5, ownedStartupFailureInjected: true, exit: { at: 20 }, closedAt: 21 },
    { pid: 7, startedAt: 22 }];
  report.initialPointerRestarts = 1;
  report.rootReadyAt = 30;
  report.startupRecovery = { failedPid: 5, recoveredPid: 7, injectedAt: 19, failedExitAt: 20, recoveredReadyAt: 25 };
  desktop.descendantDesktopObservations[4].observedAt = 18;
  desktop.descendantDesktopObservations.push({ pid: 7, threadDesktops: [desktop.ownedDesktop],
    threadObservations: [observedThread(7, desktop.ownedDesktop)], observedAt: 24, status: 'verified-owned-job-member' });
  return { report, desktop };
}
test('accepts durable Job/desktop proof for an exited startup generation before root readiness', () => {
  const { report, desktop } = startupFixture();
  assertDesktopChain(report, desktop);
});
test('accepts startup retry only after a complete successful actual thread snapshot', () => {
  const { report, desktop } = startupFixture();
  const observation = desktop.descendantDesktopObservations[4];
  observation.attempts = 2;
  observation.firstUnobserved = { pid: 5, tid: 105, api: 'GetThreadDesktop', rawHandle: '0',
    win32Error: 87, threadDesktop: null, observedAt: 17, status: 'unobserved-not-desktop-proof' };
  assertDesktopChain(report, desktop);
});
for (const [label, change] of [
  ['lost first generation', (r) => { r.helpers.shift(); }],
  ['unobserved first generation', (r, d) => { d.descendantDesktopObservations[4].status = 'exited-before-observation-not-desktop-proof'; }],
  ['late first generation observation', (r, d) => { d.descendantDesktopObservations[4].observedAt = 31; }],
  ['recovery after root readiness', (r) => { r.startupRecovery.recoveredReadyAt = 31; }],
]) {
  test(`rejects startup recovery with ${label}`, () => {
    const { report, desktop } = startupFixture();
    change(report, desktop);
    assert.throws(() => assertDesktopChain(report, desktop));
  });
}
