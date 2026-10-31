const { spawn, execFileSync } = require('node:child_process');
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
child.once('exit', (code) => {
  clearTimeout(timer);
  try {
    const report = JSON.parse(fs.readFileSync(path.join(output, 'report.json')));
    for (const pid of report.helperPids || []) {
      if (process.platform === 'win32') {
        const owned = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Write-Output ${pid} }; exit 0`],
        { encoding: 'utf8' }).trim();
        if (owned) throw new Error('Owned pointer helper survived application exit.');
      }
    }
    report.resourcesReleased = true;
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    process.exitCode = code === 0 && report.status === 'passed' ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
});
