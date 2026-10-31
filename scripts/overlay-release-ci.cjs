const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'win32' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
  throw new Error('Release observer requires an isolated GitHub-hosted Windows runner.');
}
const directory = path.resolve('artifacts-ci', 'overlay-recovery');
const child = spawn(require('electron'), [path.resolve('scripts', 'overlay-release-negative.cjs')],
  { stdio: 'inherit', env: { ...process.env, VI_OUTPUT: directory } });
const timer = setTimeout(() => { child.kill(); console.error('Release failure experiment exceeded its deadline.'); }, 60000);
child.once('error', (error) => { clearTimeout(timer); console.error(error.message); process.exitCode = 1; });
child.once('exit', (code) => {
  clearTimeout(timer);
  try {
    const report = JSON.parse(fs.readFileSync(path.join(directory, 'release-negative.json')));
    assert.equal(code, 1);
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
    fs.writeFileSync(path.join(directory, 'release-negative.json'), JSON.stringify(report, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
});
