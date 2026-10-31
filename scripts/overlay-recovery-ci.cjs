const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { assertDesktopChain, assertWrapperOutcome } = require('./overlay-ci-desktop.cjs');

if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Overlay UI checks require an isolated CI runner.');
const timeoutProbe = process.argv.includes('--desktop-timeout-probe');
if (timeoutProbe && process.platform !== 'win32') throw new Error('Owned desktop timeout probe requires Windows.');
const output = path.resolve('artifacts-ci', 'overlay-recovery', ...(timeoutProbe ? ['desktop-timeout'] : []));
fs.mkdirSync(output, { recursive: true });
const samples = 16000, wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / 16000) * 3000), 44 + i * 2);
fs.writeFileSync(path.join(output, 'input.wav'), wav);
const isolated = process.platform === 'win32';
const metadata = path.join(output, 'desktop-isolation');
if (isolated && fs.existsSync(metadata)) throw new Error('Stale desktop isolation metadata directory refused.');
const child = isolated
  ? spawn(process.env.VI_DESKTOP_PWSH || 'pwsh', ['-NoProfile', '-NonInteractive', '-File',
    path.resolve('scripts', 'windows-ci-desktop.ps1'), '-Entry', 'overlay', '-Executable', require('electron'),
    '-Output', metadata, '-WorkingDirectory', process.cwd(), '-TimeoutSeconds', timeoutProbe ? '35' : '150',
    ...(timeoutProbe ? ['-HarnessTimeoutProbe'] : ['-HarnessEarlyRecovery'])],
  { stdio: 'inherit', env: { ...process.env, VI_OUTPUT: output } })
  : spawn(require('electron'), [path.resolve('scripts', 'overlay-recovery-ui.cjs'), '--ci-mode=overlay-recovery'],
    { stdio: 'inherit', env: { ...process.env, VI_OUTPUT: output } });
const timer = isolated ? undefined : setTimeout(() => { child.kill(); console.error('Overlay UI deadline exceeded.'); }, 150000);
child.once('error', (error) => { clearTimeout(timer); console.error(error.message); process.exitCode = 1; });
child.once('exit', async (code) => {
  clearTimeout(timer);
  let report;
  try {
    if (isolated) {
      const desktop = JSON.parse(fs.readFileSync(path.join(metadata, 'report.json')));
      assertWrapperOutcome(desktop, timeoutProbe ? ['Owned child timed out.'] : []);
      if (!desktop.rootWindowsVerified) throw new Error(`Owned root readiness failed: ${desktop.errors.join('; ')}`);
      report = JSON.parse(fs.readFileSync(path.join(output, 'report.json')));
      assert.equal(desktop.controllerPid, child.pid);
      assertDesktopChain(report, desktop);
      if (!timeoutProbe) assert.ok(report.startupRecovery, 'The normal owned-desktop run requires early-generation recovery proof.');
      if (timeoutProbe) {
        assert.equal(code, 1);
        assert.equal(desktop.childOutcome, 'timeout');
        assert.equal(desktop.childExitCode, undefined);
        assert.deepEqual(desktop.errors, ['Owned child timed out.']);
        assert.equal(report.status, 'timeout-witness-ready');
        assert.equal(report.timeoutWitness.leftHeldAfter, false);
        assert.equal(report.timeoutWitness.releaseSent, false);
        const ready = JSON.parse(fs.readFileSync(path.join(metadata, 'timeout-ready.json')));
        assert.equal(ready.pid, desktop.ownedPid);
        assert.equal(ready.desktop, desktop.ownedDesktop);
        assert.equal(ready.leftHeld, false);
        assert.ok(desktop.rootWallSeconds >= 35 && desktop.rootWallSeconds < 36);
      }
      if ((!timeoutProbe && (code !== 0 || desktop.childExitCode !== 0 || !desktop.passed)) || !desktop.rootWindowsVerified ||
          !desktop.originalRestored || !desktop.ownedDesktopRemoved || !desktop.processHandlesClosed ||
          !desktop.desktopHandlesClosed || desktop.ownedJobCleanup.active !== 0 || desktop.defaultJobCleanup.active !== 0) {
        throw new Error('Owned desktop wrapper or raw overlay root did not complete all isolation cleanup gates.');
      }
      report.desktopIsolation = { metadata: 'desktop-isolation/report.json', rawRootExitCode: desktop.childExitCode,
        originalRestored: desktop.originalRestored, desktopRemoved: desktop.ownedDesktopRemoved };
    } else report = JSON.parse(fs.readFileSync(path.join(output, 'report.json')));
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
    if (timeoutProbe) report.timeoutObserver = { status: 'passed', scope: 'no owned press held before intentional stall; not timed-held recovery' };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    process.exitCode = timeoutProbe || (code === 0 && report.status === 'passed') ? 0 : 1;
  } catch (error) {
    console.error(error.message); process.exitCode = 1;
    if (report) {
      report.status = 'failed'; report.resourcesReleased = false; report.resourceError = error.message;
      fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    }
  }
});
