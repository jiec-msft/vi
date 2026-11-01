const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function nodeEvent(report, kind, extra = {}) {
  report.nodeEvents ||= [];
  assert.ok(report.nodeEvents.length < 4096, 'Owned causal event inventory exceeded its bound.');
  const request = report.causalRequests?.find((value) => value.requestId === extra.requestId);
  const identity = request ? Object.fromEntries(['sourceHead','runId','attempt','caseId','callerPid','role','generation',
    'requestId','requestNonce','requestSequence'].map((key) => [key, request[key]])) : report.causalContext;
  const event = { ...identity, eventId: report.nodeEvents.length + 1, kind, at: Date.now(),
    ticks: process.hrtime.bigint().toString(), clock: 'Node-process-hrtime', ...extra };
  report.nodeEvents.push(event);
  return event;
}
function selfReceiptStem(request, pid) {
  assert.ok(Number.isInteger(pid) && pid > 0, 'Immutable native receipt PID is missing.');
  assert.match(request.requestNonce, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  return `desktop-${request.role}-${pid}-${request.requestNonce}`;
}
function createRequest(report, role, generation, caseId) {
  report.causalRequests ||= [];
  const sequence = report.causalRequests.length + 1;
  const value = { sourceHead: process.env.VI_PROBE_HEAD, runId: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT, caseId, callerPid: process.pid, role, generation,
    requestSequence: sequence, requestId: `${process.pid}-${sequence}-${role}-${generation}`, requestNonce: randomUUID() };
  value.begin = nodeEvent(report, 'request-begin', { ...value });
  report.causalRequests.push(value);
  return value;
}
function requestEnvironment(request, base = process.env) {
  return { ...base, VI_CI_NATIVE_GENERATION: String(request.generation),
    VI_CI_NATIVE_SPAWN_REQUEST: request.requestId, VI_CI_NATIVE_REQUEST_SEQUENCE: String(request.requestSequence),
    VI_CI_NATIVE_REQUEST_NONCE: request.requestNonce, VI_CI_NATIVE_CALLER_PID: String(request.callerPid) };
}
function assertRequest(value, request) {
  for (const key of ['sourceHead', 'runId', 'attempt', 'caseId', 'callerPid', 'role', 'generation',
    'requestId', 'requestNonce', 'requestSequence']) assert.equal(value[key], request[key], `Causal ${key} mismatch.`);
}
function assertJobReceiptPath(value, request) {
  assert.ok(value.jobReceipt && typeof value.jobReceipt === 'object' && !Array.isArray(value.jobReceipt),
    'Native Job receipt must use the committed object schema, not key/value-pair arrays.');
  assert.equal(typeof value.jobReceipt.fileName, 'string', 'Committed native Job receipt filename is missing.');
  assert.equal(value.jobReceipt.fileName, `job-${request.returnedPid}-${value.creationFileTime}.json`,
    'Committed native Job receipt filename/identity mismatch.');
}
async function consumeCommitted(directory, stem, request, report) {
  const bytes = await fs.readFile(path.join(directory, `${stem}.json`));
  const commitBytes = await fs.readFile(path.join(directory, `${stem}.commit.json`));
  const value = JSON.parse(bytes), commit = JSON.parse(commitBytes);
  assertRequest(value, request); assertRequest(commit, request);
  assert.equal(commit.fileName, `${stem}.json`);
  assert.equal(commit.commitComplete, true);
  assert.equal(commit.sha256, sha256(bytes));
  assert.equal(commit.pid, request.returnedPid);
  assert.equal(commit.creationFileTime, value.creationFileTime);
  assert.equal(commit.executionThread, value.executionThread);
  assertJobReceiptPath(value, request);
  const jobBytes = await fs.readFile(path.join(request.jobDirectory, value.jobReceipt.fileName));
  const job = JSON.parse(jobBytes);
  assert.equal(sha256(jobBytes), value.jobReceipt.sha256);
  assert.equal(job.pid, request.returnedPid);
  assert.equal(job.creationFileTime, value.creationFileTime);
  assert.equal(job.specificJobMember, true);
  assert.equal(job.status, 'verified-specific-job-process-identity');
  assert.equal(job.caseId, request.caseId);
  const consumed = nodeEvent(report, 'committed-receipt-consumed', { requestId: request.requestId,
    requestNonce: request.requestNonce, fileName: commit.fileName });
  return { value, commit, sha256: sha256(bytes), commitSHA256: sha256(commitBytes),
    bytesBase64: bytes.toString('base64'), commitBytesBase64: commitBytes.toString('base64'),
    jobBytesBase64: jobBytes.toString('base64'), consumed };
}
async function executeOwnedDriver(report, request, args, outputDirectory) {
  const resultPromise = new Promise((resolve) => {
    const child = execFile('powershell.exe', args, { timeout: 15000, windowsHide: true, env: requestEnvironment(request) },
      (error, stdout, stderr) => {
        request.callback = nodeEvent(report, 'driver-callback', { requestId: request.requestId });
        resolve({ error, stdout, stderr });
      });
    request.returnedPid = child.pid;
    request.returned = nodeEvent(report, 'request-return', { requestId: request.requestId, pid: child.pid });
    child.once('spawn', () => { request.spawn = nodeEvent(report, 'process-spawn', { requestId: request.requestId, pid: child.pid }); });
    child.once('exit', (code, signal) => { request.exit = nodeEvent(report, 'process-exit', { requestId: request.requestId, code, signal }); });
    request.closed = new Promise((done) => child.once('close', (code, signal) => {
      request.close = nodeEvent(report, 'process-close', { requestId: request.requestId, code, signal }); done();
    }));
  });
  const result = await resultPromise;
  await request.closed;
  delete request.closed;
  if (!result.stdout.trim()) {
    throw result.error || new Error('Owned driver produced no complete final response.');
  }
  const value = JSON.parse(result.stdout);
  request.response = nodeEvent(report, 'driver-response-consumed', { requestId: request.requestId });
  const ack = await consumeCommitted(outputDirectory, `driver-response-${request.requestNonce}`, request, report);
  assert.equal(JSON.stringify(ack.value), JSON.stringify(value), 'Pipe response differs from committed native response.');
  const receipt = { ...value, processExitObservedAt: request.exit.at, processExitObservedTicks: request.exit.ticks,
    causalRequest: request, committedAck: ack };
  if (result.error) { result.error.nativeReceipt = receipt; throw result.error; }
  assert.equal(value.responseOutcome, 'success');
  return receipt;
}
function downAuthority(value) {
  return { ownedDownInjected: value.ownedDownInjected, ownerVerified: value.ownerVerified, leftHeldAfter: value.leftHeldAfter,
    mode: value.mode, input: value.input, ownedOwnerPid: value.ownedOwnerPid, ownedWindow: value.ownedWindow,
    threadDesktop: value.threadDesktop, inputDesktop: value.inputDesktop, requestNonce: value.requestNonce,
    responseSHA256: value.committedAck.sha256 };
}
function armOwnedEarlyInjection(helper, request, report, child, readyEvent, completed) {
  const deadline = ticks(readyEvent.causal.ticks) + 300000000n;
  helper.startupFailureScheduled = true;
  helper.startupFailureDelayMs = 300;
  helper.injectionDeadlineTicks = deadline.toString();
  helper.injectionArmed = nodeEvent(report, 'owned-injection-timer-armed', { requestId: request.requestId,
    deadlineTicks: deadline.toString() });
  const remaining = Math.max(0, Math.ceil(Number(deadline - process.hrtime.bigint()) / 1000000));
  const inject = () => {
    const left = deadline - process.hrtime.bigint();
    if (left > 0n) {
      setTimeout(inject, Math.ceil(Number(left) / 1000000));
      return;
    }
    helper.startupFailureRequestedAt = Date.now();
    helper.injection = nodeEvent(report, 'owned-injection-requested', { requestId: request.requestId, pid: child.pid });
    if (!helper.readyAcks.some((ack) => ack.readySequence === 1 &&
        ticks(ack.acknowledged.ticks) < deadline &&
        ticks(ack.acknowledged.ticks) < ticks(helper.injection.ticks))) {
      helper.proofError = 'Original 300ms injection lacked a completed matching pre-injection receipt ACK.';
    }
    helper.ownedStartupFailureInjected = child.kill();
    completed();
  };
  return setTimeout(inject, remaining);
}
async function committedHelperReady(helper, pending) {
  assert.ok(Array.isArray(pending), 'Required helper ACK inventory is missing.');
  await Promise.all(pending);
  if (helper.proofError) throw new Error(helper.proofError);
  const readyCount = helper.events.filter(({ type }) => type === 'ready').length;
  assert.ok(readyCount > 0, 'Ready helper has no actual READY event.');
  assert.equal(helper.readyAcks.length, readyCount,
    'Helper readiness requires its actual committed sidecar ACK.');
}
function helperCheckpointQueue(write, fail, held) {
  const pending = new Map();
  let active;
  const drain = () => {
    if (held || active || !pending.size) return;
    active = (async () => {
      while (!held && pending.size) {
        const [file, item] = pending.entries().next().value;
        pending.delete(file);
        try { await write(file, item.text); }
        catch (error) { fail(item.helper, error); }
      }
    })().finally(() => { active = undefined; drain(); });
  };
  return {
    enqueue(file, text, helper) {
      assert.ok(pending.has(file) || pending.size < 32, 'Bounded helper checkpoint queue exceeded.');
      pending.set(file, { text, helper }); drain();
    },
    release() { held = false; drain(); },
    async flush() { held = false; drain(); while (active) await active; },
  };
}

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
  assert.equal(receipt.monotonicClock, 'native-process-Stopwatch', 'Native receipt clock domain mismatch.');
  assert.ok(ticks(receipt.monotonicFrequency) > 0n, 'Native frequency must be positive.');
  assert.equal(receipt.selfQueryComplete, true);
  assert.ok(Number.isInteger(receipt.thread ?? receipt.driverThread) && (receipt.thread ?? receipt.driverThread) > 0);
  assert.equal(receipt.executionThread, receipt.thread ?? receipt.driverThread);
  assert.equal(receipt.station, 'WinSta0');
  assert.equal(receipt.threadDesktop, desktop.ownedDesktop);
  assert.equal(receipt.inputDesktop, desktop.ownedDesktop);
  assertCoverage(receipt, 'self-execution-thread-not-all-process-threads');
  finiteTime(receipt.queryStartedAt); finiteTime(receipt.queryCompletedAt);
  assert.ok(finiteTime(receipt.nativeQueryStartedAt) <= finiteTime(receipt.nativeQueryCompletedAt));
  assert.equal(receipt.selfLiveApi, 'WaitForSingleObject');
  assert.equal(receipt.selfLiveWaitState, 258);
  assert.equal(receipt.selfLiveWin32Error, 0);
  assert.ok(finiteTime(receipt.selfLiveCheckedAt) >= receipt.nativeQueryCompletedAt);
  assert.equal(receipt.jobReceipt.consumptionComplete, true);
  assert.equal(receipt.jobReceipt.consumptionThread, receipt.executionThread);
  assert.ok(ticks(receipt.jobReceipt.consumedTicks) <= ticks(receipt.queryStartedTicks) &&
    ticks(receipt.queryStartedTicks) <= ticks(receipt.queryCompletedTicks) &&
    ticks(receipt.queryCompletedTicks) <= ticks(receipt.selfLiveCheckedTicks));
}
function ticks(value) {
  assert.equal(typeof value, 'string', 'A native/Node clock sample must be an explicit string.');
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
  const readyEvents = helper.events.filter(({ type }) => type === 'ready');
  const matched = emissions.filter((value) => value.pid === helper.pid && value.role === helper.role);
  assert.equal(matched.length, readyEvents.length, 'Each exact pointer READY needs its own native write diagnostic.');
  let previousReceiveOrder = 0, previousReceiveTicks = 0n, previousWriteTicks = 0n;
  for (const [index, event] of readyEvents.entries()) {
    const sequence = index + 1;
    assert.equal(event.readySequence, sequence);
    if (helper.role === 'overlay-pointer') assert.equal(event.message, '{"type":"ready"}');
    else assert.equal(JSON.parse(event.message).value.ready, true);
    assert.equal(event.monotonicClock, 'Node-process-hrtime-not-native-stopwatch');
    assert.ok(Number.isInteger(event.receiveOrder) && event.receiveOrder > previousReceiveOrder);
    assert.ok(ticks(event.receivedTicks) > previousReceiveTicks);
    previousReceiveOrder = event.receiveOrder;
    previousReceiveTicks = ticks(event.receivedTicks);
    const matches = matched.filter((value) => value.readySequence === sequence);
    assert.equal(matches.length, 1, 'READY sequence must match one immutable native emission.');
    const emission = matches[0];
    for (const key of ['queryStartedAt', 'queryCompletedAt', 'queryStartedTicks', 'queryCompletedTicks',
      'selfLiveCheckedAt', 'selfLiveCheckedTicks', 'selfLiveWaitState', 'jobReceipt'])
      assert.deepEqual(emission[key], receipt[key], 'READY emission changed the completed native query proof.');
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
    assert.ok(ticks(receipt.selfLiveCheckedTicks) <= ticks(emission.writeStartedTicks) &&
      previousWriteTicks <= ticks(emission.writeStartedTicks) &&
      ticks(emission.writeStartedTicks) <= ticks(emission.writeCompletedTicks),
    `Native query/READY monotonic ordering failed: ${JSON.stringify({ receipt, emission, event })}`);
    previousWriteTicks = ticks(emission.writeCompletedTicks);
  }
}
function assertNodeEvent(event, report, request) {
  assert.equal(event.clock, 'Node-process-hrtime');
  assert.equal(event.requestId, request.requestId);
  assertRequest(event, request);
  assert.ok(Number.isInteger(event.eventId) && event.eventId > 0);
  assert.deepEqual(report.nodeEvents[event.eventId - 1], event, 'Causal event is not the actually retained event.');
  ticks(event.ticks);
}
function assertCausalRequest(request, report, desktop) {
  assert.ok(Number.isInteger(request.generation) && request.generation > 0);
  assert.ok(Number.isInteger(request.requestSequence) && request.requestSequence > 0);
  for (const key of ['sourceHead', 'runId', 'attempt', 'caseId'])
    assert.equal(request[key], report.causalContext[key]);
  assert.equal(request.caseId, desktop.ownedDesktop);
  assert.equal(request.callerPid, desktop.ownedPid);
  assert.match(request.requestNonce, /^[a-f0-9-]{36}$/);
  assert.equal(request.requestId, `${request.callerPid}-${request.requestSequence}-${request.role}-${request.generation}`);
  assertNodeEvent(request.begin, report, request);
  assertNodeEvent(request.returned, report, request);
  assertNodeEvent(request.spawn, report, request);
  assert.equal(request.returned.pid, request.returnedPid);
  assert.equal(request.spawn.pid, request.returnedPid);
  assert.ok(ticks(request.begin.ticks) <= ticks(request.returned.ticks) &&
    ticks(request.returned.ticks) <= ticks(request.spawn.ticks));
}
function assertCommitted(ack, request, report, observation) {
  const value = JSON.parse(Buffer.from(ack.bytesBase64, 'base64'));
  const commit = JSON.parse(Buffer.from(ack.commitBytesBase64, 'base64'));
  assert.deepEqual(ack.value, value);
  assert.deepEqual(ack.commit, commit);
  assertRequest(value, request); assertRequest(commit, request);
  assert.equal(sha256(Buffer.from(ack.bytesBase64, 'base64')), ack.sha256);
  assert.equal(sha256(Buffer.from(ack.commitBytesBase64, 'base64')), ack.commitSHA256);
  assert.equal(commit.sha256, ack.sha256);
  assert.equal(commit.commitComplete, true);
  assert.equal(commit.pid, request.returnedPid);
  assert.equal(value.pid, request.returnedPid);
  assert.equal(commit.creationFileTime, observation.creationFileTime);
  assert.equal(value.creationFileTime, observation.creationFileTime);
  assert.equal(commit.executionThread, value.executionThread);
  assert.equal(commit.monotonicClock, 'native-process-Stopwatch');
  assert.equal(value.monotonicClock, 'native-process-Stopwatch', 'Committed value clock domain mismatch.');
  assert.equal(commit.monotonicClock, value.monotonicClock);
  assert.ok(ticks(value.monotonicFrequency) > 0n, 'Committed native frequency must be positive.');
  assert.equal(commit.monotonicFrequency, value.monotonicFrequency);
  const job = JSON.parse(Buffer.from(ack.jobBytesBase64, 'base64'));
  assert.deepEqual(job, observation, 'Consumed immutable Job bytes differ from the independent observation.');
  assert.equal(value.jobReceipt.sha256, sha256(Buffer.from(ack.jobBytesBase64, 'base64')));
  assert.equal(value.jobReceipt.fileName, `job-${request.returnedPid}-${observation.creationFileTime}.json`);
  assert.equal(value.jobReceipt.pid, observation.pid);
  assert.equal(value.jobReceipt.creationFileTime, observation.creationFileTime);
  assert.equal(value.jobReceipt.snapshotCompletedAt, observation.snapshotCompletedAt);
  assert.equal(value.jobReceipt.liveCheckedAt, observation.liveCheckedAt);
  assert.ok(ticks(value.selfLiveCheckedTicks) <= ticks(commit.committedTicks));
  if (value.writeComplete) assert.ok(ticks(value.writeCompletedTicks) <= ticks(commit.committedTicks));
  if (value.responseComplete) assert.ok(ticks(value.responseReadyTicks) <= ticks(commit.committedTicks));
  assertNodeEvent(ack.consumed, report, request);
}
function assertRootReadyEvent(event, report, desktop) {
  assert.ok(event && typeof event === 'object', 'Root readiness event is missing.');
  assert.equal(event.kind, 'root-ready');
  assert.equal(event.clock, 'Node-process-hrtime', 'Root readiness clock domain mismatch.');
  for (const key of ['sourceHead', 'runId', 'attempt', 'caseId', 'callerPid'])
    assert.equal(event[key], report.causalContext[key], 'Root readiness context mismatch.');
  assert.equal(event.callerPid, desktop.ownedPid);
  assert.ok(Number.isInteger(event.eventId) && event.eventId > 0);
  assert.deepEqual(report.nodeEvents[event.eventId - 1], event, 'Root readiness event is detached from the retained inventory.');
  ticks(event.ticks);
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
function assertRootReport(report) {
  if (report.status === 'failed') throw new Error(`Raw overlay root failed: ${report.error}`);
}
function assertWrapperOutcome(desktop, expectedErrors = []) {
  assert.ok(Array.isArray(desktop.errors), 'Owned desktop wrapper lacks its raw errors.');
  assert.deepEqual(desktop.errors, expectedErrors,
    `Owned desktop wrapper outcome failed: ${JSON.stringify({ childOutcome: desktop.childOutcome,
      childExitCode: desktop.childExitCode, errors: desktop.errors, defaultHeartbeatCheck: desktop.defaultHeartbeatCheck })}`);
}
function assertDesktopChain(report, desktop) {
  assert.equal(report.causalContext.sourceHead, desktop.headSha);
  assert.equal(report.causalContext.runId, desktop.runId);
  assert.equal(report.causalContext.attempt, desktop.attempt);
  assert.equal(report.causalContext.caseId, desktop.ownedDesktop);
  assert.equal(report.causalContext.callerPid, desktop.ownedPid);
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
    assert.equal(observation.sourceHead, desktop.headSha);
    assert.equal(observation.runId, desktop.runId);
    assert.equal(observation.attempt, desktop.attempt);
    assert.equal(observation.caseId, desktop.ownedDesktop);
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
  assert.ok(Array.isArray(metrics), 'Required Electron process inventory is missing.');
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
  const requests = report.causalRequests || [];
  for (const [index, event] of (report.nodeEvents || []).entries()) {
    assert.equal(event.eventId, index + 1); assert.equal(event.clock, 'Node-process-hrtime');
    if (index) assert.ok(ticks(report.nodeEvents[index - 1].ticks) <= ticks(event.ticks), 'Node event order regressed.');
  }
  assert.equal(new Set(requests.map(({ requestNonce }) => requestNonce)).size, requests.length, 'Request nonce reused.');
  assert.equal(new Set(requests.map(({ requestId }) => requestId)).size, requests.length, 'Request identity reused.');
  report.foreignChronologyDiagnostics = [];
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
    const request = helper.causalRequest;
    assertCausalRequest(request, report, desktop);
    assert.equal(request.returnedPid, helper.pid);
    assert.ok(Number.isInteger(helper.generation) && helper.generation > 0);
    assert.ok(helper.generation <= 4, 'Native helper lifetime generation cap exceeded.');
    assert.ok(helpers.filter((value) => value.role === helper.role && value.generation === helper.generation).length === 1);
    const next = helpers.find((value) => value.role === helper.role && value.generation === helper.generation + 1);
    if (next) {
      assertNodeEvent(helper.exit.causal, report, request); assertNodeEvent(helper.close, report, request);
      assert.ok(ticks(helper.exit.causal.ticks) <= ticks(helper.close.ticks) &&
        ticks(helper.close.ticks) <= ticks(next.causalRequest.begin.ticks), 'Replacement precedes actual exit and close.');
      assert.equal(helper.close.code, helper.exit.code);
      assert.equal(helper.close.signal, helper.exit.signal);
    }
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
    finiteTime(helper.startedAt); finiteTime(ready.at);
    report.foreignChronologyDiagnostics.push({ kind: 'helper', chronology: JSON.parse(chronology),
      bornBeforeNodeStart: job.processCreatedAt <= helper.startedAt, nodeStartBeforeNativeQuery: helper.startedAt <= receipt.queryCompletedAt,
      jobLiveBeforeForeignQuery: job.liveCheckedAt <= receipt.queryStartedAt, nativeQueryBeforeNodeReady: receipt.queryCompletedAt <= ready.at,
      nativeQueryBeforeNodeExit: !helper.exit || receipt.queryCompletedAt <= helper.exit.at });
    assert.ok(job.processCreatedAt <= receipt.queryStartedAt, 'Native-only birth interval invalid.');
    assert.equal(helper.readyAcks.length, helper.events.filter(({ type }) => type === 'ready').length);
    for (const ack of helper.readyAcks) {
      assert.equal(ack.self.commit.fileName, `${selfReceiptStem(request, helper.pid)}.json`);
      assert.equal(ack.ready.commit.fileName,
        `desktop-ready-${helper.role}-${helper.pid}-${request.requestNonce}-${ack.readySequence}.json`);
      assertCommitted(ack.self, request, report, job); assertCommitted(ack.ready, request, report, job);
      assert.deepEqual(ack.self.value, receipt);
      const event = helper.events.find((value) => value.readySequence === ack.readySequence);
      assertNodeEvent(event.causal, report, request); assertNodeEvent(ack.acknowledged, report, request);
      assert.ok(ticks(request.spawn.ticks) <= ticks(event.causal.ticks) &&
        ticks(event.causal.ticks) <= ticks(ack.self.consumed.ticks) &&
        ticks(ack.self.consumed.ticks) <= ticks(ack.ready.consumed.ticks) &&
        ticks(ack.ready.consumed.ticks) <= ticks(ack.acknowledged.ticks));
      assert.equal(ack.ready.commit.readySequence, event.readySequence);
      if (helper.exit) assert.ok(ticks(event.causal.ticks) <= ticks(helper.exit.causal.ticks), 'Late READY event after exit.');
    }
  }
  assert.equal(receipts.length, helpers.length, 'Unjoined native receipts cannot stand in for required roles.');
  assert.equal((report.nativeReadyReceipts || []).length,
    helpers.reduce((count, helper) => count + helper.events.filter(({ type }) => type === 'ready').length, 0),
    'Unjoined READY diagnostics cannot stand in for required generations.');
  for (const receipt of [...report.osInputs, ...(report.cleanupRelease ? [report.cleanupRelease] : [])]) {
    assert.equal(receipt.role, 'os-mouse-driver');
    assertSelfThread(receipt, desktop);
    const job = member(receipt.driverPid, receipt.creationFileTime);
    const request = receipt.causalRequest;
    assertCausalRequest(request, report, desktop);
    assert.equal(request.returnedPid, receipt.driverPid);
    assertCommitted(receipt.committedAck, request, report, job);
    assert.deepEqual(receipt.committedAck.value, Object.fromEntries(Object.entries(receipt)
      .filter(([key]) => !['causalRequest', 'committedAck', 'processExitObservedAt', 'processExitObservedTicks', 'at', 'stage'].includes(key))));
    assert.equal(receipt.responseComplete, true);
    assert.equal(receipt.inputExecutionThread, receipt.executionThread);
    assert.ok(ticks(receipt.selfLiveCheckedTicks) <= ticks(receipt.guardStartedTicks) &&
      ticks(receipt.guardStartedTicks) <= ticks(receipt.guardCompletedTicks) &&
      ticks(receipt.guardCompletedTicks) <= ticks(receipt.inputCompletedTicks) &&
      ticks(receipt.inputCompletedTicks) <= ticks(receipt.responseReadyTicks));
    if (receipt.inputAttempted) {
      assert.equal(receipt.guardOutcome, 'passed');
      assert.ok(ticks(receipt.guardCompletedTicks) <= ticks(receipt.inputStartedTicks) &&
        ticks(receipt.inputStartedTicks) <= ticks(receipt.inputCompletedTicks));
    }
    else assert.equal(receipt.inputPerformed, false);
    for (const event of [request.exit, request.callback, request.close, request.response]) assertNodeEvent(event, report, request);
    assert.ok(ticks(request.spawn.ticks) <= ticks(request.exit.ticks) && ticks(request.exit.ticks) <= ticks(request.callback.ticks) &&
      ticks(request.callback.ticks) <= ticks(request.close.ticks) && ticks(request.close.ticks) <= ticks(request.response.ticks) &&
      ticks(request.response.ticks) <= ticks(receipt.committedAck.consumed.ticks));
    assert.equal(receipt.responseOutcome, request.exit.code === 0 ? 'success' : 'error');
    if (receipt.cleanupUpOnly && receipt.releaseSent) {
      const authority = receipt.authorityReceipt;
      assert.equal(authority.consumptionComplete, true);
      assert.equal(authority.consumptionThread, receipt.executionThread);
      assert.ok(ticks(authority.consumedTicks) <= ticks(receipt.guardStartedTicks));
      const down = report.osInputs.find((value) => value.requestNonce === authority.requestNonce);
      assert.ok(down && down.ownedDownInjected && down.ownerVerified && down.leftHeldAfter);
      assert.equal(authority.sha256, down.committedAck.sha256);
      assert.equal(authority.pid, down.driverPid);
      assert.equal(authority.creationFileTime, down.creationFileTime);
    }
    report.foreignChronologyDiagnostics.push({ kind: 'driver', pid: receipt.driverPid,
      jobLiveBeforeForeignQuery: job.liveCheckedAt <= receipt.queryStartedAt,
      nativeQueryBeforeNodeExit: receipt.queryCompletedAt <= receipt.processExitObservedAt,
      queryCompletedAt: receipt.queryCompletedAt, processExitObservedAt: receipt.processExitObservedAt });
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
    finiteTime(recovery.injectedAt); finiteTime(recovery.failedExitAt); finiteTime(recovery.recoveredReadyAt); finiteTime(report.rootReadyAt);
    const ack = failed.readyAcks.find(({ readySequence }) => readySequence === 1);
    assert.equal(failed.startupFailureDelayMs, 300);
    assertNodeEvent(recovery.injection, report, failed.causalRequest);
    assertNodeEvent(failed.injectionArmed, report, failed.causalRequest);
    assert.equal(ticks(failed.injectionDeadlineTicks), ticks(failed.events[0].causal.ticks) + 300000000n);
    assert.ok(ticks(failed.injectionArmed.ticks) <= ticks(failed.injectionDeadlineTicks) &&
      ticks(failed.injectionDeadlineTicks) <= ticks(recovery.injection.ticks));
    assertRootReadyEvent(report.rootReadyEvent, report, desktop);
    assert.ok(ticks(ack.acknowledged.ticks) < ticks(failed.injectionDeadlineTicks) &&
      ticks(ack.acknowledged.ticks) < ticks(recovery.injection.ticks), 'Actual committed receipt ACK must precede the fixed injection deadline.');
    assert.ok(ticks(recovery.injection.ticks) <= ticks(failed.exit.causal.ticks) &&
      ticks(failed.exit.causal.ticks) <= ticks(failed.close.ticks) &&
      ticks(failed.close.ticks) <= ticks(recovered.causalRequest.begin.ticks));
    assert.ok(ticks(recovered.events[0].causal.ticks) <= ticks(report.rootReadyEvent.ticks),
      'Recovered READY occurs after the actual retained root readiness event.');
    report.foreignChronologyDiagnostics.push({ kind: 'startup-injection', pid: failed.pid,
      jobLiveBeforeForeignInjection: job.liveCheckedAt < recovery.injectedAt,
      nativeQueryBeforeForeignInjection: receipt.queryCompletedAt < recovery.injectedAt,
      injectedAt: recovery.injectedAt, queryCompletedAt: receipt.queryCompletedAt });
  }
  assert.equal(requests.length, helpers.length + report.osInputs.length + (report.cleanupRelease ? 1 : 0), 'Unjoined causal request.');
  report.clockProofContract = 'per-clock-causal-identity-v1';
}

module.exports = { assertDesktopChain, assertWrapperOutcome, nodeEvent, createRequest, requestEnvironment,
  consumeCommitted, executeOwnedDriver, downAuthority, armOwnedEarlyInjection, helperCheckpointQueue, assertJobReceiptPath,
  selfReceiptStem, assertRootReport, committedHelperReady };
