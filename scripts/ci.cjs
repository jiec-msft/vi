const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const mode = process.argv[2];
assert.ok(['smoke', 'ui', 'framework-ui'].includes(mode));
const output = path.resolve('artifacts-ci', mode);
fs.mkdirSync(output, { recursive: true });
const samples = 16000, wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / 16000) * 3000), 44 + i * 2);
fs.writeFileSync(path.join(output, 'input.wav'), wav);
const started = Date.now();
let timedOut = false;
const entry = mode === 'framework-ui' ? path.resolve('scripts', 'framework-ui.cjs') : path.resolve('src', 'main.cjs');
const child = spawn(require('electron'), [entry, `--ci-mode=${mode}`],
  { env: { ...process.env, VI_OUTPUT: output, VI_EXPECTED_ARCH: process.env.VI_EXPECTED_ARCH || process.arch },
    stdio: 'inherit' });
const timer = setTimeout(() => { timedOut = true; child.kill(); console.error('Internal test deadline exceeded.'); }, mode === 'smoke' ? 90000 : 420000);
child.once('error', () => { clearTimeout(timer); console.error('App process could not start.'); process.exitCode = 1; });
child.once('exit', (code) => {
  clearTimeout(timer);
  console.log(JSON.stringify({ mode, executionSeconds: (Date.now() - started) / 1000, code }));
  process.exitCode = !timedOut && code === 0 ? 0 : 1;
});
