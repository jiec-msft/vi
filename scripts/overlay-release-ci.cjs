const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { assertDesktopChain, assertWrapperOutcome } = require('./overlay-ci-desktop.cjs');

if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'win32' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
  throw new Error('Release observer requires an isolated GitHub-hosted Windows runner.');
}
const directory = path.resolve('artifacts-ci', 'overlay-recovery');
const metadata = path.join(directory, 'release-desktop-isolation');
if (fs.existsSync(metadata)) throw new Error('Stale release desktop isolation metadata directory refused.');
const child = spawn(process.env.VI_DESKTOP_PWSH || 'pwsh', ['-NoProfile', '-NonInteractive', '-File',
  path.resolve('scripts', 'windows-ci-desktop.ps1'), '-Entry', 'release-negative',
  '-Executable', require('electron'), '-Output', metadata, '-WorkingDirectory', process.cwd(), '-TimeoutSeconds', '60'],
{ stdio: 'inherit', env: { ...process.env, VI_OUTPUT: directory } });
child.once('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code) => {
  try {
    const desktop = JSON.parse(fs.readFileSync(path.join(metadata, 'report.json')));
    assertWrapperOutcome(desktop, ['Owned child failed with exit code 1.']);
    const report = JSON.parse(fs.readFileSync(path.join(directory, 'release-negative.json')));
    assert.equal(desktop.controllerPid, child.pid);
    assertDesktopChain(report, desktop);
    assert.ok(Number.isInteger(report.renderEvidence.paintAttempts) && report.renderEvidence.paintAttempts > 0);
    assert.ok(Number.isFinite(report.renderEvidence.paintStartedAt) && Number.isFinite(report.renderEvidence.paintCompletedAt) &&
      report.renderEvidence.paintCompletedAt >= report.renderEvidence.paintStartedAt &&
      report.renderEvidence.paintCompletedAt - report.renderEvidence.paintStartedAt <= 5000);
    assert.ok(Number.isFinite(report.rootReadyAt) && report.rootReadyAt >= report.renderEvidence.paintCompletedAt,
      'Release root readiness must follow actual dual-marker paint.');
    assert.equal(code, 1);
    assert.equal(desktop.childOutcome, 'exit');
    assert.equal(desktop.childExitCode, 1);
    assert.deepEqual(desktop.errors, ['Owned child failed with exit code 1.']);
    assert.equal(desktop.rootWindowsVerified, true);
    assert.equal(desktop.originalRestored, true);
    assert.equal(desktop.ownedDesktopRemoved, true);
    assert.equal(desktop.processHandlesClosed, true);
    assert.equal(desktop.desktopHandlesClosed, true);
    assert.equal(desktop.ownedJobCleanup.active, 0);
    assert.equal(desktop.defaultJobCleanup.active, 0);
    assert.equal(report.status, 'expected-failure-cleaned');
    assert.equal(report.originalFailure.exitCode, 1);
    assert.equal(report.originalFailure.expectedBaselineGuard, true);
    assert.equal(report.heldAfterRejectedNormalUp, true);
    assert.equal(report.cleanup.leftHeldBefore, true);
    assert.equal(report.cleanup.leftHeldAfter, false);
    assert.equal(report.cleanup.foregroundUnchanged, true);
    assert.equal(report.noOwnedDown.rejected, true);
    assert.equal(report.newPressWithoutAuthority.heldBefore, true);
    assert.equal(report.newPressWithoutAuthority.heldAfter, true);
    report.observer = { status: 'passed', originalExperimentExitCode: code, failureNotConvertedToSuccess: true };
    report.desktopIsolation = { metadata: 'release-desktop-isolation/report.json', rawRootExitCode: desktop.childExitCode,
      originalRestored: desktop.originalRestored, desktopRemoved: desktop.ownedDesktopRemoved };
    fs.writeFileSync(path.join(directory, 'release-negative.json'), JSON.stringify(report, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
});
