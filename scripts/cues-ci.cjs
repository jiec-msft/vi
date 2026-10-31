const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Cue probes run only on isolated CI runners.');
assert.equal(process.arch, process.env.VI_EXPECTED_ARCH);
assert.match(process.env.VI_CUES_HEAD || '', /^[0-9a-f]{40}$/);
const output = path.resolve('artifacts-ci', 'cues');
fs.mkdirSync(output, { recursive: true });
const child = spawn(require('electron'), [path.resolve('scripts', 'cues-native.cjs'), '--ci-mode=cues'],
  { env: { ...process.env, VI_CUES_OUTPUT: output }, stdio: 'inherit' });
const timer = setTimeout(() => { console.error('Cue probe execution deadline exceeded.'); child.kill(); }, 180000);
child.once('error', (error) => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
child.once('exit', (code) => {
  clearTimeout(timer);
  try {
    assert.equal(code, 0, `Native cue probe exited with code ${code}.`);
    const report = JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8'));
    assert.equal(report.status, 'passed', report.error || report.evidenceError || report.cleanupError);
    assert.equal(report.headSha, process.env.VI_CUES_HEAD);
    assert.equal(report.contextCount, 23);
    assert.equal(report.recordings.length, 12);
    assert.ok(report.videoBytes > 0 && report.checks.includes('actual-destination-graph-and-pcm'));
    assert.ok(report.contexts.every((context) => context.state === 'closed' && context.closeCalls === 1));
    for (const recording of report.recordings) {
      assert.ok(recording.sampleCount > 0 && recording.peak > 0.02 && recording.peak <= 0.091);
      assert.ok(fs.statSync(path.join(output, recording.pcmFile)).size > 44);
    }
    for (const filename of ['desktop.webm', 'desktop.png']) assert.ok(fs.statSync(path.join(output, filename)).size > 0);
    console.log(JSON.stringify({ status: report.status, headSha: report.headSha,
      contexts: report.contextCount, recordings: report.recordings.length, videoBytes: report.videoBytes }));
  } catch (error) {
    console.error('Native cue probe failed or its evidence is incomplete.', error);
    process.exitCode = 1;
  }
});
