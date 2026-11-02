const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { NativeDelivery } = require('../app/native-delivery.cjs');
const { nativeHelperEnvironment } = require('../app/native-diagnostics.cjs');

assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.equal(process.arch, process.env.VI_EXPECTED_ARCH);
const variant = process.argv[2];
assert.ok(['candidate', 'legacy-inherited', 'legacy-cleared', 'inbox-autoload'].includes(variant));
const directory = path.resolve('artifacts-ci', 'native-startup', variant);
fs.mkdirSync(directory, { recursive: true });
const execute = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { status: 'failed', variant, architecture: process.arch, node: process.version,
  controllerPid: process.pid, windowsHide: true, redirectedStandardStreams: true,
  sourceRevision: process.env.GITHUB_SHA, scope: 'CI-only native startup; no microphone, service or app GUI',
  freshProcess: true, uncachedOsOrDiskClaimed: false };
function imageIdentity(file) {
  const data = fs.readFileSync(file);
  assert.equal(data.readUInt16LE(0), 0x5a4d);
  const header = data.readUInt32LE(0x3c);
  assert.equal(data.readUInt32LE(header), 0x4550);
  return { path: file, machine: data.readUInt16LE(header + 4),
    sha256: createHash('sha256').update(data).digest('hex') };
}
async function run() {
  if (variant !== 'candidate') {
    const env = variant === 'inbox-autoload' ? nativeHelperEnvironment() : { ...process.env };
    if (variant === 'legacy-cleared') {
      for (const key of Object.keys(env)) if (key.toUpperCase() === 'PSMODULEPATH') delete env[key];
    }
    const script = `
$ErrorActionPreference='Stop'
[Console]::Error.WriteLine('VI_PROBE entry')
[Console]::Out.WriteLine("SELF|$PID|$([IntPtr]::Size)|$($PSVersionTable.PSVersion.Major)|$($PSVersionTable.PSEdition)|$([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)")
[Console]::Error.WriteLine('VI_PROBE before-forms')
Add-Type -AssemblyName System.Windows.Forms
[Console]::Error.WriteLine('VI_PROBE forms-ready')
Add-Type -TypeDefinition 'public static class ViStartupFixture { public static int Value() { return 1; } }'
if([ViStartupFixture]::Value() -ne 1){throw 'Native type did not execute.'}
$command=Get-Command Add-Type -ErrorAction Stop
[Console]::Out.WriteLine("COMMAND|$($command.ModuleName)|$($command.Module.Path)")
[Console]::Out.WriteLine('DONE|1')
`;
    let childPid;
    await new Promise((resolve, reject) => {
      const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')], {
        env, windowsHide: true, timeout: 8000, maxBuffer: 16384, encoding: 'utf8',
      }, (error, stdout, stderr) => {
        try {
          report.pid = childPid;
          report.progress = stderr.split(/\r?\n/).filter((line) => /^VI_PROBE [a-z-]+$/.test(line)).slice(0, 8);
          const self = stdout.split(/\r?\n/).find((line) => line.startsWith('SELF|'))?.split('|');
          if (self) {
            assert.equal(Number(self[1]), childPid);
            report.pointerBytes = Number(self[2]);
            report.engineMajor = Number(self[3]);
            report.edition = self[4];
            report.image = imageIdentity(self[5]);
          }
          report.command = stdout.split(/\r?\n/).find((line) => line.startsWith('COMMAND|'));
          if (error) {
            report.timedOut = error.killed === true;
            report.errorCode = error.code;
            reject(error);
          } else {
            assert.ok(stdout.split(/\r?\n/).includes('DONE|1'));
            resolve();
          }
        } catch (failure) { reject(failure); }
      });
      childPid = child.pid;
    });
  } else {
    // This is the first native fixture in its fresh runner, not a warmed replacement.
    report.nativeSources = {};
    for (const name of ['windows-delivery.ps1', 'windows-bootstrap.ps1', 'windows-diagnostics.ps1',
      'windows-input.ps1', 'windows-clipboard-snapshot.cs']) {
      report.nativeSources[name] = createHash('sha256').update(fs.readFileSync(path.join('native', name))).digest('hex');
    }
    const driver = new NativeDelivery('win32', path.resolve('native'));
    const started = performance.now();
    const child = driver.process;
    report.pid = child.pid;
    report.metadataObserverOverlappedReadiness = true;
    let metadata;
    try {
      const ready = driver.request('ready');
      await Promise.resolve();
      const core = path.join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe');
      const query = `$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${child.pid}';` +
        `if($null -eq $p -or $p.ParentProcessId -ne ${process.pid}){throw 'Owned helper parent mismatch.'};` +
        `[pscustomobject]@{pid=$p.ProcessId;parent=$p.ParentProcessId;image=$p.ExecutablePath;session=$p.SessionId;` +
        `created=$p.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()}|ConvertTo-Json -Compress`;
      metadata = execute(core, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(query, 'utf16le').toString('base64')], { timeout: 5000, windowsHide: true, maxBuffer: 16384 })
        .then(({ stdout }) => {
          const identity = JSON.parse(stdout);
          assert.equal(identity.pid, child.pid);
          assert.equal(identity.parent, process.pid);
          assert.equal(path.win32.basename(identity.image).toLowerCase(), 'powershell.exe');
          report.identity = identity;
          report.image = imageIdentity(identity.image);
          return identity;
        }).catch((error) => {
          report.metadataError = { code: error.code, errorClass: error.name, killed: error.killed === true };
          return undefined;
        });
      assert.deepEqual(await ready, { ready: true });
      report.readinessMs = Math.round(performance.now() - started);
      report.actualReady = true;
      const identity = await metadata;
      assert.ok(identity, 'Actual owned helper image identity was not observed.');
    } catch (error) {
      report.readinessError = error.message;
      throw error;
    } finally {
      report.startup = driver.trace.startup;
      report.stderrBytes = driver.trace.stderrBytes;
      const exited = child.exitCode === null && child.signalCode === null ? once(child, 'exit') : undefined;
      driver.close();
      if (metadata) await metadata;
      try {
        if (exited) await Promise.race([exited, pause(2000).then(() => { throw new Error('Owned helper did not exit.'); })]);
      } catch (error) { report.cleanupError = error.message; throw error; }
      report.helperExited = child.exitCode !== null || child.signalCode !== null;
    }
  }
  report.status = 'passed';
}
run().catch((error) => { report.error = error.message; process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
});
