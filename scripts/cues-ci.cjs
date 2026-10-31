const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Cue probes run only on isolated CI runners.');
assert.equal(process.arch, process.env.VI_EXPECTED_ARCH);
const output = path.resolve('artifacts-ci', 'cues');
fs.mkdirSync(output, { recursive: true });
const child = spawn(require('electron'), [path.resolve('scripts', 'cues-native.cjs'), '--ci-mode=cues'],
  { env: { ...process.env, VI_CUES_OUTPUT: output }, stdio: 'inherit' });
const timer = setTimeout(() => { console.error('Cue probe execution deadline exceeded.'); child.kill(); }, 180000);
child.once('error', (error) => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
child.once('exit', (code) => { clearTimeout(timer); process.exitCode = code === 0 ? 0 : 1; });
