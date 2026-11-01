const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { NativeDelivery } = require('../../app/native-delivery.cjs');

test('caret marker, field lease and owned fixture types compile without opening native windows',
  { skip: process.platform !== 'win32' }, () => {
    const script = `$ErrorActionPreference='Stop'\n` +
      `Add-Type -AssemblyName System.Windows.Forms,System.Drawing,UIAutomationClient,UIAutomationTypes\n` +
      `Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing,UIAutomationClient,UIAutomationTypes,WindowsBase ` +
      `-Path '${path.resolve('native', 'windows-caret.cs').replaceAll("'", "''")}'\n` +
      `Add-Type -ReferencedAssemblies System.Windows.Forms -Path '${path.resolve('native', 'windows-caret-lease.cs').replaceAll("'", "''")}'\n` +
      `Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -Path '${path.resolve('scripts', 'windows-caret-fixture.cs').replaceAll("'", "''")}'\n` +
      `if([ViCaret].FullName -ne 'ViCaret' -or [ViCaretLease].FullName -ne 'ViCaretLease' -or [ViCaretFixture].FullName -ne 'ViCaretFixture'){throw 'Caret native type missing.'}\n`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { timeout: 20000, stdio: 'pipe' });
  });

test('Windows delivery helper compiles and answers readiness without desktop or clipboard access',
  { skip: process.platform !== 'win32' }, async () => {
    const driver = new NativeDelivery('win32', path.resolve('native'));
    try { assert.deepEqual(await driver.request('ready'), { ready: true }); }
    finally { driver.close(); }
  });

test('Windows pointer sampler cancels unavailable input once and never resumes a held gesture',
  { skip: process.platform !== 'win32' }, () => {
    const source = readFileSync(path.resolve('native', 'windows-overlay.ps1'), 'utf8');
    const type = source.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/)[1];
    const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${type}\n'@\n` + `
$mouse = New-Object OverlayMouse
if ($mouse.Sample($false, $true, 100, 200) -ne '{"type":"ready"}') { throw 'Initial readiness missing.' }
if ($mouse.Sample($true, $true, 100, 200) -notmatch '"type":"down"') { throw 'Press missing.' }
if ($mouse.Suspend() -ne "{\`"type\`":\`"cancel\`"}\`n{\`"type\`":\`"suspended\`"}") { throw 'Cancellation missing.' }
if ($null -ne $mouse.Suspend()) { throw 'Repeated suspension emitted an event.' }
if ($mouse.Sample($true, $true, 140, 240) -ne '{"type":"ready"}') { throw 'Recovery readiness missing.' }
if ($null -ne $mouse.Sample($true, $true, 160, 260)) { throw 'Held gesture resumed.' }
if ($null -ne $mouse.Sample($false, $true, 160, 260)) { throw 'Cancelled gesture released twice.' }
if ($mouse.Sample($true, $true, 160, 260) -notmatch '"type":"down"') { throw 'Fresh press missing.' }
if ($mouse.SampleUnavailable(0) -ne "{\`"type\`":\`"cancel\`"}\`n{\`"type\`":\`"suspended\`"}") { throw 'Unavailable transition missing.' }
if ($null -ne $mouse.SampleUnavailable(999)) { throw 'Heartbeat emitted before one second.' }
if ($mouse.SampleUnavailable(1000) -ne '{"type":"heartbeat"}') { throw 'Suspended heartbeat missing.' }
if ($null -ne $mouse.SampleUnavailable(1999)) { throw 'Repeated heartbeat emitted too early.' }
for ($time = 2000; $time -le 120000; $time += 1000) {
    if ($mouse.SampleUnavailable($time) -ne '{"type":"heartbeat"}') { throw 'Long suspension lost liveness.' }
}
if ($mouse.Sample($true, $true, 160, 260) -ne '{"type":"ready"}') { throw 'Long-suspension readiness missing.' }
if ($null -ne $mouse.Sample($true, $true, 180, 280)) { throw 'Long-suspension gesture resumed.' }
`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { timeout: 20000, stdio: 'pipe' });
  });
