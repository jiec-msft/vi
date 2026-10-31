const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Overlay UI checks require an isolated CI runner.');
const output = path.resolve('artifacts-ci', 'overlay-recovery');
fs.mkdirSync(output, { recursive: true });
const samples = 16000, wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / 16000) * 3000), 44 + i * 2);
fs.writeFileSync(path.join(output, 'input.wav'), wav);
const child = spawn(require('electron'), [path.resolve('scripts', 'overlay-recovery-ui.cjs'), '--ci-mode=overlay-recovery'],
  { stdio: 'inherit', env: { ...process.env, VI_OUTPUT: output } });
const timer = setTimeout(() => { child.kill(); console.error('Overlay UI deadline exceeded.'); }, 150000);
child.once('error', (error) => { clearTimeout(timer); console.error(error.message); process.exitCode = 1; });
child.once('exit', async (code) => {
  clearTimeout(timer);
  let report;
  try {
    report = JSON.parse(fs.readFileSync(path.join(output, 'report.json')));
    for (const helper of report.helpers) {
      if (!Number.isInteger(helper.pid)) continue;
      const exists = () => {
        try { process.kill(helper.pid, 0); return true; }
        catch (error) { if (error.code === 'ESRCH') return false; throw error; }
      };
      const deadline = Date.now() + 2000;
      while (exists() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      if (exists()) throw new Error(`Owned ${helper.role} helper survived application exit.`);
      helper.observedAbsentAt = Date.now();
    }
    report.resourcesReleased = true;
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    process.exitCode = code === 0 && report.status === 'passed' ? 0 : 1;
  } catch (error) {
    console.error(error.message); process.exitCode = 1;
    if (report) {
      report.status = 'failed'; report.resourcesReleased = false; report.resourceError = error.message;
      fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    }
  }
});
