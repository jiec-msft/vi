const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { assertDesktopChain, assertWrapperOutcome, armOwnedEarlyInjection, helperCheckpointQueue, nodeEvent,
  assertJobReceiptPath, selfReceiptStem, assertRootReport } = require('./overlay-ci-desktop.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
test('actual PS5 Json producer preserves the committed nested receipt object schema', {
  skip: process.platform !== 'win32', timeout: 20000,
}, async () => {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const directory = path.resolve('artifacts-ci', 'overlay-recovery', 'serialization-probe');
  await fs.mkdir(directory, { recursive: true });
  const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive',
    '-File', path.resolve('scripts', 'overlay-ci-desktop-attest.ps1'),
    '-DesktopName', `vi-ci-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${'a'.repeat(32)}`,
    '-Output', directory, '-JobOutput', directory, '-Generation', '1', '-Role', 'overlay-pointer', '-SerializationProbe'],
  { windowsHide: true, timeout: 15000 });
  const value = JSON.parse(result.stdout.trim());
  assert.equal(value.scope, 'serialization-only-not-job-membership');
  assert.equal(value.complete, true);
  assert.equal(typeof value.pid, 'number');
  assertJobReceiptPath(value, { returnedPid: value.pid });
  assert.equal(value.jobReceipt.pid, value.pid);
  assert.equal(value.jobReceipt.sha256, createHash('sha256').update('serialization-only-not-job-proof').digest('hex'));
  assert.equal(JSON.stringify(value).includes('__type'), false);
  assert.equal(value.firstReceiptStem, selfReceiptStem({ role: 'os-mouse-driver',
    requestNonce: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }, value.pid));
  assert.equal(value.secondReceiptStem, selfReceiptStem({ role: 'os-mouse-driver',
    requestNonce: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }, value.pid));
  assert.notEqual(value.firstReceiptStem, value.secondReceiptStem);
  const first = await fs.readFile(path.join(directory, `${value.firstReceiptStem}.json`), 'utf8');
  const second = await fs.readFile(path.join(directory, `${value.secondReceiptStem}.json`), 'utf8');
  assert.deepEqual(JSON.parse(first), { ...value, requestNonce: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
  assert.deepEqual(JSON.parse(second), { ...value, requestNonce: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });
  assert.equal(await fs.readFile(path.join(directory, `${value.firstReceiptStem}.json`), 'utf8'), first);
});
test('primary failed root with no metrics preserves the native cause', () => {
  assert.throws(() => assertRootReport({ status: 'failed', error: 'native immutable file already exists' }),
    { message: /native immutable file already exists/ });
});
for (const requestNonce of ['------------------------------------', 'aaaaaaaa/aaaa-aaaa-aaaa-aaaaaaaaaaaa']) {
  test('immutable self naming rejects malformed or path-separated nonce', () => {
    assert.throws(() => selfReceiptStem({ role: 'os-mouse-driver', requestNonce }, 7), { name: 'AssertionError' });
  });
}
for (const [label, jobReceipt] of [['key/value array', [{ key: 'fileName', value: 'job-1-2.json' }]], ['missing filename', {}]]) {
  test(`production consumer rejects ${label} before filesystem lookup`, () => {
    assert.throws(() => assertJobReceiptPath({ creationFileTime: '2', jobReceipt }, { returnedPid: 1 }),
      { name: 'AssertionError' });
  });
}

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
const context = { sourceHead: 'a'.repeat(40), runId: '1', attempt: '1', caseId: 'vi-ci-test', callerPid: 1 };
for (const acknowledged of [true, false]) {
  test(`fixed READY injection is independent of pending diagnostic I/O (ACK ${acknowledged})`, async () => {
    const report = { causalContext: { ...context }, nodeEvents: [] };
    const request = { ...context, role: 'overlay-pointer', generation: 1, requestSequence: 1,
      requestId: '1-1-overlay-pointer-1', requestNonce: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
    report.causalRequests = [request];
    const helper = { readyAcks: [] };
    const failure = new Error('controlled diagnostic I/O failure');
    let rejectWriter, writes = 0, completed = false, killed = 0;
    const queue = helperCheckpointQueue(() => {
      writes++;
      return new Promise((resolve, reject) => { rejectWriter = reject; });
    }, (value, error) => { value.proofError = error.message; }, true);
    queue.enqueue('controlled-checkpoint', '{}', helper);
    const ready = { causal: nodeEvent(report, 'helper-line', { requestId: request.requestId }) };
    const injected = new Promise((resolve) => {
      armOwnedEarlyInjection(helper, request, report, { pid: 5, kill: () => {
        assert.equal(writes, 0, 'Optional diagnostic writer must not begin in the original critical window.');
        killed++; return true;
      } }, ready, () => { completed = true; queue.release(); resolve(); });
    });
    assert.equal(helper.injectionDeadlineTicks, (BigInt(ready.causal.ticks) + 300000000n).toString());
    assert.equal(writes, 0);
    if (acknowledged) helper.readyAcks.push({ readySequence: 1,
      acknowledged: nodeEvent(report, 'helper-ready-ack', { requestId: request.requestId }) });
    await injected;
    assert.equal(killed, 1); assert.equal(completed, true);
    assert.ok(BigInt(helper.injection.ticks) >= BigInt(helper.injectionDeadlineTicks));
    if (!acknowledged) assert.match(helper.proofError, /Original 300ms injection lacked/);
    assert.equal(writes, 1);
    rejectWriter(failure);
    await queue.flush();
    assert.equal(helper.proofError, failure.message, 'Diagnostic error cannot become a successful fallback.');
  });
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function reencodeAck(ack) {
  const bytes = Buffer.from(JSON.stringify(ack.value));
  ack.sha256 = hash(bytes); ack.bytesBase64 = bytes.toString('base64'); ack.commit.sha256 = ack.sha256;
  const commit = Buffer.from(JSON.stringify(ack.commit));
  ack.commitSHA256 = hash(commit); ack.commitBytesBase64 = commit.toString('base64');
}
const unknownThread = { pid: 1, tid: 101, api: 'GetThreadDesktop', rawHandle: '0',
  win32Error: 5, status: 'unobserved-not-desktop-proof', threadDesktop: null };
function member(pid) {
  return { pid, creationFileTime: birth(pid), processCreatedAt: 1000, observedAt: 1080, snapshotCompletedAt: 1090,
    specificJobMember: true, liveAtCompletion: true, membershipApi: 'IsProcessInJob',
    liveCheckedAt: 1091, liveCheckApi: 'WaitForSingleObject', liveCheckWaitState: 258, liveCheckWin32Error: 0,
    coverage: 'specific-job-process-identity-not-thread-desktop', status: 'verified-specific-job-process-identity',
    processCreationApi: 'GetProcessTimes', processCreationClock: 'Win32-FILETIME-not-Node-Date.now',
    threadObservations: [{ ...unknownThread, pid }] };
}
function self(pid, role, desktop) {
  return { pid, role, creationFileTime: birth(pid), thread: 105, executionThread: 105, station: 'WinSta0',
    threadDesktop: desktop, inputDesktop: desktop, selfQueryComplete: true, queryStartedAt: 1100, queryCompletedAt: 1101,
    generation: 1, queryStartedTicks: '11000', queryCompletedTicks: '11010',
    requestId: `1-1-${role}-1`, requestSequence: 1,
    monotonicFrequency: '10000000', monotonicClock: 'native-process-Stopwatch',
    coverage: 'self-execution-thread-not-all-process-threads' };
}
function readyEvent(at, receivedTicks = '20000') {
  return { type: 'ready', at, readySequence: 1, receiveOrder: 1, receivedTicks,
    message: '{"type":"ready"}', monotonicClock: 'Node-process-hrtime-not-native-stopwatch' };
}
function emission(pid, generation = 1) {
  return { pid, role: 'overlay-pointer', creationFileTime: birth(pid), generation, executionThread: 105,
    requestId: `1-${generation}-overlay-pointer-${generation}`, requestSequence: generation,
    readySequence: 1, messageBase64: Buffer.from('{"type":"ready"}').toString('base64'),
    writeApi: 'Console.WriteLine', writeComplete: true, writeStartedAt: 1110, writeCompletedAt: 1111,
    writeStartedTicks: '11100', writeCompletedTicks: '11110',
    monotonicFrequency: '10000000', monotonicClock: 'native-process-Stopwatch' };
}
function spawnDiagnostics(generation = 1) {
  return { requestId: `1-${generation}-overlay-pointer-${generation}`, requestSequence: generation, callerPid: 1,
    returnedPid: generation === 1 ? 5 : 7,
    spawnStartedAt: generation === 1 ? 1000 : 1518, spawnReturnedAt: generation === 1 ? 1001 : 1519,
    spawnObservedAt: generation === 1 ? 1002 : 1521,
    spawnStartedTicks: generation === 1 ? '10000' : '25000',
    spawnReturnedTicks: generation === 1 ? '10010' : '25010', spawnObservedTicks: generation === 1 ? '10020' : '25020',
    helperStartedTicks: generation === 1 ? '10015' : '25015',
    spawnClock: 'Node-process-hrtime', startedAtClock: 'Node-Date.now-not-native-FILETIME',
    startedAtMeaning: 'observer-after-synchronous-spawn-return-before-spawn-event' };
}
function causalFixture(report, desktop) {
  report.causalContext = { ...context };
  Object.assign(desktop, { headSha: context.sourceHead, runId: '1', attempt: '1' });
  for (const member of desktop.descendantDesktopObservations)
    Object.assign(member, { sourceHead: context.sourceHead, runId: '1', attempt: '1', caseId: desktop.ownedDesktop });
  report.nodeEvents = []; report.causalRequests = [];
  const event = (request, kind, tick, extra = {}) => {
    const value = { ...request, kind, ticks: String(BigInt(tick) * 100000n), clock: 'Node-process-hrtime', at: 1200, ...extra };
    delete value.begin; delete value.returned; delete value.spawn;
    report.nodeEvents.push(value);
    return value;
  };
  const request = (role, generation, pid, base) => {
    const sequence = report.causalRequests.length + 1;
    const value = { ...context, role, generation, returnedPid: pid, requestSequence: sequence,
      requestId: `1-${sequence}-${role}-${generation}`, requestNonce: `${String(sequence).padStart(8, '0')}-aaaa-aaaa-aaaa-aaaaaaaaaaaa` };
    value.begin = event(value, 'request-begin', base);
    value.returned = event(value, 'request-return', base + 1, { pid });
    value.spawn = event(value, 'process-spawn', base + 2, { pid });
    report.causalRequests.push(value);
    return value;
  };
  const bindSelf = (receipt, req, job) => {
    Object.assign(receipt, context, { pid: req.returnedPid, role: req.role, generation: req.generation,
      requestId: req.requestId, requestNonce: req.requestNonce, requestSequence: req.requestSequence,
      selfLiveApi: 'WaitForSingleObject', selfLiveWaitState: 258, selfLiveWin32Error: 0,
      selfLiveCheckedAt: receipt.queryCompletedAt + 1, selfLiveCheckedTicks: String(BigInt(receipt.queryCompletedTicks) + 1n),
      nativeQueryStartedAt: receipt.queryStartedAt, nativeQueryCompletedAt: receipt.queryCompletedAt,
      jobReceipt: { fileName: `job-${job.pid}-${job.creationFileTime}.json`, sha256: hash(Buffer.from(JSON.stringify(job))),
        pid: job.pid, creationFileTime: job.creationFileTime, snapshotCompletedAt: job.snapshotCompletedAt,
        liveCheckedAt: job.liveCheckedAt, consumptionComplete: true, consumptionThread: receipt.executionThread,
        consumedTicks: String(BigInt(receipt.queryStartedTicks) - 1n) } });
  };
  const ack = (value, req, job, stem, tick) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const commit = { ...context, pid: req.returnedPid, role: req.role, generation: req.generation,
      requestId: req.requestId, requestNonce: req.requestNonce, requestSequence: req.requestSequence,
      creationFileTime: value.creationFileTime, executionThread: value.executionThread, fileName: `${stem}.json`,
      commitComplete: true, sha256: hash(bytes), monotonicClock: value.monotonicClock, monotonicFrequency: value.monotonicFrequency,
      committedTicks: String(BigInt(value.writeCompletedTicks || value.responseReadyTicks || value.selfLiveCheckedTicks) + 1n),
      ...(value.readySequence ? { readySequence: value.readySequence } : {}) };
    const commitBytes = Buffer.from(JSON.stringify(commit)), jobBytes = Buffer.from(JSON.stringify(job));
    return { value, commit, sha256: hash(bytes), commitSHA256: hash(commitBytes),
      bytesBase64: bytes.toString('base64'), commitBytesBase64: commitBytes.toString('base64'),
      jobBytesBase64: jobBytes.toString('base64'), consumed: event(req, 'committed-receipt-consumed', tick) };
  };
  report.nativeReadyReceipts = report.nativeReadyReceipts.slice(0, report.helpers.length);
  for (const [index, helper] of report.helpers.entries()) {
    const req = request(helper.role, helper.generation, helper.pid, index ? 25000 : 10000);
    helper.causalRequest = req; helper.requestId = req.requestId; helper.requestSequence = req.requestSequence;
    helper.requestNonce = req.requestNonce;
    const receipt = report.nativeDesktopReceipts[index], job = desktop.descendantDesktopObservations.find((v) => v.pid === helper.pid);
    bindSelf(receipt, req, job);
    const ready = helper.events[0];
    ready.causal = event(req, 'helper-line', Number(ready.receivedTicks));
    const oldEmission = report.nativeReadyReceipts[index];
    const readyFields = Object.fromEntries(['readySequence', 'messageBase64', 'writeApi', 'writeComplete',
      'writeStartedAt', 'writeCompletedAt', 'writeStartedTicks', 'writeCompletedTicks'].map((key) => [key, oldEmission[key]]));
    const emissionValue = { ...receipt, ...readyFields,
      ...context, requestId: req.requestId, requestNonce: req.requestNonce, requestSequence: req.requestSequence };
    report.nativeReadyReceipts[index] = emissionValue;
    helper.readyAcks = [{ readySequence: 1, self: ack(receipt, req, job, selfReceiptStem(req, helper.pid), Number(ready.receivedTicks) + 1),
      ready: ack(emissionValue, req, job, `desktop-ready-${helper.role}-${helper.pid}-${req.requestNonce}-1`, Number(ready.receivedTicks) + 2),
      acknowledged: event(req, 'helper-ready-ack', Number(ready.receivedTicks) + 3) }];
    if (helper.exit) {
      helper.exit.code = 0; helper.exit.signal = null;
      helper.exit.causal = event(req, 'process-exit', 24000, { code: 0, signal: null });
      helper.close = event(req, 'process-close', 24001, { code: 0, signal: null });
    }
  }
  for (const [index, receipt] of report.osInputs.entries()) {
    const req = request('os-mouse-driver', index + 1, receipt.driverPid, report.helpers.length > 1 ? 35000 : 21000);
    const job = desktop.descendantDesktopObservations.find((v) => v.pid === receipt.driverPid);
    bindSelf(receipt, req, job);
    Object.assign(receipt, { mode: 'hover', responseOutcome: 'success', responseComplete: true,
      guardStartedTicks: '11100', guardCompletedTicks: '11101', inputStartedTicks: '11102',
      inputCompletedTicks: '11103', responseReadyTicks: '11104', inputAttempted: true, inputPerformed: true,
      inputExecutionThread: receipt.executionThread, guardOutcome: 'passed' });
    req.exit = event(req, 'process-exit', 45000, { code: 0 });
    req.callback = event(req, 'driver-callback', 45001);
    req.close = event(req, 'process-close', 45002, { code: 0 });
    req.response = event(req, 'driver-response-consumed', 45003);
    const value = Object.fromEntries(Object.entries(receipt).filter(([key]) =>
      !['processExitObservedAt', 'processExitObservedTicks', 'causalRequest', 'committedAck'].includes(key)));
    receipt.committedAck = ack(value, req, job, `driver-response-${req.requestNonce}`, 45004);
    receipt.causalRequest = req;
  }
  if (report.startupRecovery) {
    const failed = report.helpers[0];
    failed.startupFailureDelayMs = 300;
    failed.injectionDeadlineTicks = (BigInt(failed.events[0].causal.ticks) + 300000000n).toString();
    failed.injectionArmed = event(failed.causalRequest, 'owned-injection-timer-armed', 20000);
    report.startupRecovery.injection = event(failed.causalRequest, 'owned-injection-requested', 23000);
    report.rootReadyEvent = { ...context, kind: 'root-ready', ticks: '3100000000', clock: 'Node-process-hrtime' };
    report.nodeEvents.push(report.rootReadyEvent);
  }
  reindexNodeEvents(report);
}
function reindexNodeEvents(report) {
  report.nodeEvents.sort((a, b) => Number(BigInt(a.ticks) - BigInt(b.ticks)));
  report.nodeEvents.forEach((value, index) => { value.eventId = index + 1; });
}
function fixture() {
  const name = 'vi-ci-test';
  const report = { windowIds: { owner: 1, main: '11', overlay: '12' },
    electronProcesses: [{ pid: 1, type: 'Browser' }, { pid: 2, type: 'GPU' },
      { pid: 3, type: 'Tab' }, { pid: 4, type: 'Tab' }].map((value) => ({ ...value, creationTime: 1000 })),
    helpers: [{ pid: 5, role: 'overlay-pointer', generation: 1, startedAt: 1001, events: [readyEvent(1120)], ...spawnDiagnostics() }],
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
  causalFixture(report, desktop);
  return { report, desktop };
}
test('accepts explicit role-specific proof while retaining inaccessible remote threads as nonproof', () => {
  const { report, desktop } = fixture();
  assertDesktopChain(report, desktop);
});
test('valid identity and causal order accept retained foreign UTC inversion as diagnostic', () => {
  const { report, desktop } = fixture();
  report.nativeDesktopReceipts[0].queryCompletedAt = 1126;
  report.nativeDesktopReceipts[0].selfLiveCheckedAt = 1127;
  report.nativeReadyReceipts[0].writeStartedAt = 1127;
  report.nativeReadyReceipts[0].writeCompletedAt = 1128;
  causalFixture(report, desktop);
  assertDesktopChain(report, desktop);
  assert.equal(report.foreignChronologyDiagnostics[0].nativeQueryBeforeNodeReady, false);
});
test('kernel birth versus Node observer inversion remains diagnostic with real identity and causal witnesses', () => {
  const { report, desktop } = fixture();
  desktop.descendantDesktopObservations[4].processCreatedAt = 1002;
  causalFixture(report, desktop);
  assertDesktopChain(report, desktop);
  assert.equal(report.foreignChronologyDiagnostics[0].bornBeforeNodeStart, false);
});
test('a no-held status witness references exactly one canonical causal driver receipt', () => {
  const { report, desktop } = fixture();
  report.timeoutWitness = report.osInputs[0];
  assertDesktopChain(report, desktop);
});
test('a repeated timeout status receipt is not a second actual causal request', () => {
  const { report, desktop } = fixture();
  report.timeoutWitness = report.osInputs[0];
  report.osInputs.push({ ...report.timeoutWitness });
  assert.throws(() => assertDesktopChain(report, desktop), { name: 'AssertionError', message: /Unjoined causal request/ });
});
for (const [label, value] of [['wrong domain', 'Node-process-hrtime'], ['missing frequency', undefined], ['zero frequency', '0']]) {
  test(`driver ${label} with internally valid content hashes is rejected semantically`, () => {
    const { report, desktop } = fixture();
    const receipt = report.osInputs[0], ack = receipt.committedAck;
    const field = label === 'wrong domain' ? 'monotonicClock' : 'monotonicFrequency';
    if (value === undefined) { delete receipt[field]; delete ack.value[field]; }
    else { receipt[field] = value; ack.value[field] = value; }
    reencodeAck(ack);
    assert.throws(() => assertDesktopChain(report, desktop), { name: 'AssertionError' });
  });
}
for (const [label, change, reason] of [
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
  ['missing process inventory', (r) => { delete r.electronProcesses; }, /Required Electron process inventory is missing/],
  ['metrics PID reuse', (r) => { r.electronProcesses[1].creationTime = 2000; }],
  ['role coverage overclaim', (r) => { r.electronProcesses[1].allThreadDesktop = true; }],
  ['Job falsely marked desktop verified', (r, d) => { d.descendantDesktopObservations[1].desktopVerified = true; }],
  ['render evidence missing', (r) => { r.renderEvidence.overlayMarkerVisible = false; }],
  ['unjoined native receipt', (r) => { r.nativeDesktopReceipts[0].pid = 99; }],
  ['native process birth mismatch', (r) => { r.nativeDesktopReceipts[0].creationFileTime = birth(99); }],
  ['missing actual spawn request', (r) => { delete r.helpers[0].requestId; }],
  ['returned spawn PID mismatched', (r) => { r.helpers[0].returnedPid = 99; }],
  ['spawn return precedes request ticks', (r) => { r.helpers[0].spawnReturnedTicks = '9999'; }],
  ['spawn event precedes returned process', (r) => { r.helpers[0].spawnObservedTicks = '10001'; }],
  ['native spawn request mismatched', (r) => { r.nativeDesktopReceipts[0].requestId = 'other'; }],
  ['native request sequence mismatched', (r) => { r.nativeDesktopReceipts[0].requestSequence = 99; }],
  ['native READY spawn request mismatched', (r) => { r.nativeReadyReceipts[0].requestId = 'other'; }],
  ['stale nonce self receipt name', (r) => { r.helpers[0].readyAcks[0].self.commit.fileName = 'desktop-os-mouse-driver-5.json'; }],
  ['birth clock relabeled as Node', (r, d) => { d.descendantDesktopObservations[4].processCreationClock = 'Node-Date.now'; }],
  ['missing causal context', (r) => { delete r.causalContext.sourceHead; }],
  ['reused request nonce', (r) => { r.causalRequests[1].requestNonce = r.causalRequests[0].requestNonce; }],
  ['wrong consumed Job hash', (r) => { r.nativeDesktopReceipts[0].jobReceipt.sha256 = '0'.repeat(64); }],
  ['wrong receipt consumption thread', (r) => { r.nativeDesktopReceipts[0].jobReceipt.consumptionThread = 999; }],
  ['query before actual receipt consumption', (r) => { r.nativeDesktopReceipts[0].jobReceipt.consumedTicks = '11001'; }],
  ['post-query live check reports exit', (r) => { r.nativeDesktopReceipts[0].selfLiveWaitState = 0; }],
  ['post-query live check precedes completion', (r) => { r.nativeDesktopReceipts[0].selfLiveCheckedTicks = '11009'; }],
  ['native sidecar commit incomplete', (r) => { r.helpers[0].readyAcks[0].ready.commit.commitComplete = false; }],
  ['native sidecar hash forged', (r) => { r.helpers[0].readyAcks[0].ready.sha256 = '0'.repeat(64); }],
  ['Node ACK precedes sidecar consumption', (r) => { r.helpers[0].readyAcks[0].acknowledged.ticks = '20000'; }],
  ['driver final response incomplete', (r) => { r.osInputs[0].responseComplete = false; }],
  ['driver response input thread wrong', (r) => { r.osInputs[0].inputExecutionThread = 999; }],
  ['driver query precedes consumed Job receipt', (r) => { r.osInputs[0].jobReceipt.consumedTicks = '11001'; }],
  ['driver response belongs to another nonce', (r) => { r.osInputs[0].requestNonce = 'ffffffff-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; }],
  ['partial self-query', (r) => { r.nativeDesktopReceipts[0].selfQueryComplete = false; }],
  ['wrong native execution thread', (r) => { r.nativeDesktopReceipts[0].executionThread = 999; }],
  ['default native thread', (r) => { r.nativeDesktopReceipts[0].threadDesktop = 'Default'; }],
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
    assert.throws(() => assertDesktopChain(report, desktop), { name: 'AssertionError', ...(reason ? { message: reason } : {}) });
  });
}
function startupFixture() {
  const { report, desktop } = fixture();
  Object.assign(report.helpers[0], { ownedStartupFailureInjected: true, exit: { at: 1500 }, closedAt: 1510 });
  report.helpers.push({ pid: 7, role: 'overlay-pointer', generation: 2, startedAt: 1520, ...spawnDiagnostics(2),
    events: [readyEvent(1580, '30000')] });
  report.initialPointerRestarts = 1;
  report.rootReadyAt = 1600;
  report.startupRecovery = { failedPid: 5, recoveredPid: 7, injectedAt: 1400, failedExitAt: 1500, recoveredReadyAt: 1580 };
  desktop.descendantDesktopObservations.push({ ...member(7), processCreatedAt: 1515,
    observedAt: 1560, snapshotCompletedAt: 1570, liveCheckedAt: 1571 });
  report.nativeDesktopReceipts.push({ ...self(7, 'overlay-pointer', desktop.ownedDesktop),
    generation: 2, requestId: '1-2-overlay-pointer-2', requestSequence: 2, queryStartedAt: 1572, queryCompletedAt: 1573 });
  report.nativeReadyReceipts.push({ ...emission(7, 2), writeStartedAt: 1574, writeCompletedAt: 1575 });
  causalFixture(report, desktop);
  return { report, desktop };
}
test('requires both completed generation proofs before the injected startup exit', () => {
  const { report, desktop } = startupFixture();
  assertDesktopChain(report, desktop);
});
for (const [label, change, reason] of [
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
  ['overlapping generations', (r) => { r.helpers[1].causalRequest.begin.ticks = '2300000000'; reindexNodeEvents(r); },
    /Replacement precedes actual exit and close/],
  ['recovery after root readiness', (r) => {
    const helper = r.helpers[1], ack = helper.readyAcks[0];
    helper.events[0].causal.ticks = '3200000000';
    ack.self.consumed.ticks = '3200100000'; ack.ready.consumed.ticks = '3200200000';
    ack.acknowledged.ticks = '3200300000'; reindexNodeEvents(r);
  }, /Recovered READY occurs after/],
  ['injection before actual committed ACK', (r) => {
    r.helpers[0].readyAcks[0].acknowledged.ticks = '2310000000'; reindexNodeEvents(r);
  }, /Actual committed receipt ACK must precede/],
  ['missing pre-injection completed ACK', (r) => { r.helpers[0].readyAcks = []; }],
  ['replacement before actual close', (r) => { r.helpers[0].close.ticks = '2600000000'; reindexNodeEvents(r); },
    /Replacement precedes actual exit and close/],
  ['detached root ready event', (r) => { r.rootReadyEvent = { ...r.rootReadyEvent, ticks: '999999999999' }; }],
  ['wrong root ready clock domain', (r) => { r.rootReadyEvent.clock = 'native-process-Stopwatch'; }],
  ['wrong root ready context', (r) => { r.rootReadyEvent.caseId = 'other'; }],
  ['wrong root ready event ID', (r) => { r.rootReadyEvent.eventId = 999; }],
]) {
  test(`rejects startup proof with ${label}`, () => {
    const { report, desktop } = startupFixture();
    change(report, desktop);
    assert.throws(() => assertDesktopChain(report, desktop), { name: 'AssertionError', ...(reason ? { message: reason } : {}) });
  });
}
