const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { NativeDelivery } = require('../../app/native-delivery.cjs');

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
`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { timeout: 20000, stdio: 'pipe' });
  });
