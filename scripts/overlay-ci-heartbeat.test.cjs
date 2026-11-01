const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('real Default fixture publishes new immutable frames while old reader handles remain open',
  { timeout: 30000 }, async () => {
    assert.ok(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted' &&
      process.env.RUNNER_OS === 'Windows' && process.platform === 'win32' &&
      process.arch === process.env.VI_EXPECTED_ARCH && ['x64', 'arm64'].includes(process.arch),
    'Heartbeat protocol verification requires native GitHub-hosted Windows CI.');
    const directory = path.resolve('artifacts-ci', 'overlay-recovery', 'heartbeat-reader');
    await fs.mkdir(path.dirname(directory), { recursive: true });
    await fs.mkdir(directory);
    const child = spawn(process.env.VI_DESKTOP_PWSH, ['-NoProfile', '-NonInteractive', '-File',
      path.resolve('scripts', 'overlay-ci-heartbeat-reader.ps1'), '-Directory', directory,
      '-Executable', require('electron'), '-WorkingDirectory', process.cwd()],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = '';
    child.stdout.on('data', (bytes) => { diagnostics += bytes; });
    child.stderr.on('data', (bytes) => { diagnostics += bytes; });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const timer = setTimeout(() => child.kill(), 25000);
    try {
      const outcome = await exited;
      const report = JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8').catch((error) => {
        throw new Error(`Heartbeat child has no readable report: ${JSON.stringify({ outcome, diagnostics })}`, { cause: error });
      }));
      assert.equal(outcome.code, 0, `Immutable protocol verification failed: ${JSON.stringify({ outcome, report, diagnostics })}`);
      assert.equal(report.passed, true);
      assert.deepEqual(report.errors, []);
      assert.equal(report.readerPid, child.pid);
      assert.equal(report.protocol, 'vi-ci-immutable-heartbeat-v1');
      assert.equal(report.completedOverlaps, 64);
      assert.equal(report.overlaps.length, 64);
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
      assert.equal(report.producerFailure.childExitCode, 1);
      assert.equal(report.producerFailure.stoppedAfterPublishedFrames, 1);
      assert.equal(report.defaultJobCleanup.active, 0);
      assert.equal(report.producerFailureJobCleanup.active, 0);
      assert.equal(report.processHandlesClosed, true);
      assert.equal(report.readerHandlesClosed, true);
      assert.equal(report.originalDefaultUnchanged, true);
      assert.equal(report.fixtureWindowsRemoved, true);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
  });
