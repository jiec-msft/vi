const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');

function assertProtocolCompletion(report) {
  assert.equal(report.completedOverlaps, 64, 'All 64 actual held-reader overlaps are required.');
  assert.equal(report.overlaps?.length, 64);
  assert.equal(report.producerFailure?.childExitCode, 1, 'The actual intended producer failure must retain exit 1.');
  assert.equal(report.producerFailure.stoppedAfterPublishedFrames, 1);
}
for (const [label, change] of [
  ['missing count', (value) => { delete value.completedOverlaps; }],
  ['partial overlaps', (value) => { value.completedOverlaps = 63; value.overlaps.pop(); }],
  ['missing overlap receipt', (value) => { value.overlaps.pop(); }],
  ['missing producer failure', (value) => { delete value.producerFailure; }],
  ['producer failure changed to success', (value) => { value.producerFailure.childExitCode = 0; }],
  ['missing stopped-producer witness', (value) => { delete value.producerFailure.stoppedAfterPublishedFrames; }],
]) {
  test(`completion gate rejects ${label}`, () => {
    const report = { completedOverlaps: 64, overlaps: Array(64).fill(null),
      producerFailure: { childExitCode: 1, stoppedAfterPublishedFrames: 1 } };
    change(report);
    assert.throws(() => assertProtocolCompletion(report));
  });
}
test('real Default fixture publishes new immutable frames while old reader handles remain open',
  { timeout: 30000 }, async () => {
    assert.ok(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted' &&
      process.env.RUNNER_OS === 'Windows' && process.platform === 'win32' &&
      process.arch === process.env.VI_EXPECTED_ARCH && ['x64', 'arm64'].includes(process.arch),
    'Heartbeat protocol verification requires native GitHub-hosted Windows CI.');
    const directory = path.resolve('artifacts-ci', 'overlay-recovery', 'heartbeat-reader');
    const preparation = path.resolve('artifacts-ci', 'overlay-recovery', `heartbeat-preparation-${process.env.VI_PROBE_HEAD}`);
    const launch = { startedAt: Date.now(), startedTicks: process.hrtime.bigint().toString(),
      monotonicClock: 'measured-Node-hrtime-not-preparation-or-native-clock' };
    const saveLaunch = () => writeFileSync(path.join(preparation, 'launcher.json'), JSON.stringify(launch, null, 2));
    let persistenceError, rejectExecution;
    const saveEvent = () => {
      try { saveLaunch(); }
      catch (error) { persistenceError = error; console.error(error); rejectExecution?.(error); }
    };
    saveLaunch();
    const manifest = JSON.parse(await fs.readFile(path.join(preparation, 'manifest.json'), 'utf8'));
    assert.equal(manifest.sourceHead, process.env.VI_PROBE_HEAD);
    assert.equal(manifest.runId, process.env.GITHUB_RUN_ID);
    assert.equal(manifest.attempt, process.env.GITHUB_RUN_ATTEMPT);
    assert.equal(manifest.nativeArchitecture, process.arch);
    assert.equal(manifest.verificationDirectory, directory);
    assert.equal(manifest.sourcePath, path.resolve('scripts', 'windows-ci-desktop-native.cs'));
    assert.equal(manifest.assemblyPath, path.join(preparation, 'heartbeat-native.dll'));
    assert.equal(createHash('sha256').update(await fs.readFile(manifest.sourcePath)).digest('hex').toUpperCase(), manifest.sourceSHA256);
    assert.equal(createHash('sha256').update(await fs.readFile(manifest.assemblyPath)).digest('hex').toUpperCase(), manifest.assemblySHA256);
    assert.deepEqual(manifest.negativeProvenanceCases.map(({ field }) => field),
      ['sourceHead', 'sourceSHA256', 'assemblySHA256', 'nativeArchitecture', 'verificationDirectory', 'missing-manifest', 'stale-content']);
    assert.deepEqual(await fs.readdir(directory), []);
    launch.preflightCompletedAt = Date.now();
    launch.spawnCallStartedAt = Date.now();
    launch.spawnCallStartedTicks = process.hrtime.bigint().toString();
    saveLaunch();
    const child = spawn(process.env.VI_DESKTOP_PWSH, ['-NoProfile', '-NonInteractive', '-File',
      path.resolve('scripts', 'overlay-ci-heartbeat-reader.ps1'), '-Directory', directory,
      '-Preparation', preparation, '-WorkingDirectory', process.cwd()],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    launch.childPid = child.pid;
    launch.spawnCallCompletedAt = Date.now();
    launch.spawnCallCompletedTicks = process.hrtime.bigint().toString();
    child.once('spawn', () => { launch.spawnObservedAt = Date.now(); saveEvent(); });
    let diagnostics = '';
    child.stdout.on('data', (bytes) => { diagnostics += bytes; });
    child.stderr.on('data', (bytes) => { diagnostics += bytes; });
    const exited = new Promise((resolve, reject) => {
      rejectExecution = reject;
      child.once('error', (error) => { launch.error = error.message; saveEvent(); reject(error); });
      child.once('exit', (code, signal) => {
        launch.exit = { code, signal, observedAt: Date.now(), ticks: process.hrtime.bigint().toString() };
        saveEvent(); resolve({ code, signal });
      });
    });
    const closed = new Promise((resolve) => {
      child.once('close', (code, signal) => { launch.close = { code, signal, observedAt: Date.now() }; saveEvent(); resolve(); });
    });
    launch.timerArmedAt = Date.now();
    launch.timerMilliseconds = 25000;
    saveEvent();
    const timer = setTimeout(() => {
      launch.timedKillRequestedAt = Date.now();
      saveEvent();
      launch.timedKillReturned = child.kill();
      launch.timedKillReturnedAt = Date.now();
      saveEvent();
    }, 25000);
    try {
      const outcome = await exited;
      await closed;
      assert.ifError(persistenceError);
      const report = JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8').catch((error) => {
        throw new Error(`Heartbeat child has no readable report: ${JSON.stringify({ outcome, diagnostics })}`, { cause: error });
      }));
      assert.equal(outcome.code, 0, `Immutable protocol verification failed: ${JSON.stringify({ outcome, report, diagnostics })}`);
      assert.equal(report.passed, true);
      assert.deepEqual(report.errors, []);
      assert.equal(report.readerPid, child.pid);
      assert.equal(report.protocol, 'vi-ci-immutable-heartbeat-v1');
      assertProtocolCompletion(report);
      assert.ok(report.finalFrameCount >= 65 && report.finalFrameCount <= report.frameLimit);
      assert.deepEqual(report.freshnessBoundary, { at2999: true, at3000: false, wrongPid: false });
      for (const [index, receipt] of report.overlaps.entries()) {
        assert.equal(receipt.iteration, index);
        assert.equal(receipt.oldFrame.pid, report.producerPid);
        assert.equal(receipt.nextFrame.pid, report.producerPid);
        assert.equal(receipt.oldFrame.creationFileTime, report.producerCreationFileTime);
        assert.equal(receipt.nextFrame.creationFileTime, report.producerCreationFileTime);
        assert.equal(receipt.oldFrame.generation, 1);
        assert.equal(receipt.nextFrame.generation, 1);
        assert.ok(receipt.nextFrame.sequence > receipt.knownPublishedSequenceAfterOpen);
        assert.ok(receipt.knownPublishedSequenceAfterOpen >= receipt.oldFrame.sequence);
        assert.notEqual(receipt.oldFrame.fileName, receipt.nextFrame.fileName);
        assert.ok(receipt.handleOpenedAt <= receipt.heldReadCompletedAt);
        assert.equal(receipt.nextProof.specificDefaultJobMember, true);
        assert.equal(receipt.nextProof.liveCheckWaitState, 258);
        assert.equal(receipt.nextProof.liveCheckWin32Error, 0);
        assert.ok(receipt.nextProof.visibleWindowCount > 0);
        assert.ok(receipt.nextProof.liveCheckedAt >= receipt.nextProof.snapshotCompletedAt);
        assert.ok(receipt.nextProof.ageMilliseconds < 3000);
      }
      assert.deepEqual(report.negativeCases, ['missing', 'tmp-only', 'malformed', 'partial-final', 'wrong-pid',
        'wrong-birth', 'wrong-generation', 'wrong-sequence', 'wrong-filename', 'sequence-format', 'duplicate', 'gap',
        'invalid-time', 'invalid-time-type', 'wrong-protocol', 'duplicate-property', 'over-cap', 'stale-latest']);
      assert.deepEqual(report.negativeWitnesses.map(({ label }) => label), report.negativeCases);
      assert.ok(report.negativeWitnesses.every(({ exceptionType, error }) => exceptionType && error));
      assert.equal(report.defaultJobCleanup.active, 0);
      assert.equal(report.producerFailureJobCleanup.active, 0);
      assert.equal(report.processHandlesClosed, true);
      assert.equal(report.readerHandlesClosed, true);
      assert.equal(report.originalDefaultUnchanged, true);
      assert.equal(report.fixtureWindowsRemoved, true);
      launch.bodyCompletedAt = Date.now();
      launch.bodyCompletedTicks = process.hrtime.bigint().toString();
      saveLaunch();
      report.preparation = { manifest: path.relative(directory, path.join(preparation, 'manifest.json')),
        elapsedSeconds: manifest.elapsedSeconds, phases: manifest.phases,
        scope: 'charged to the same entire UI job; not part of the bounded measured test or P0 proof' };
      report.measuredLauncher = launch;
      await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        launch.finallyKillRequestedAt = Date.now();
        saveEvent();
        launch.finallyKillReturned = child.kill();
        saveEvent();
      }
      await exited;
    }
  });
