const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { NativeTrace, parseNativeStartup, nativeHelperEnvironment } = require('../../app/native-diagnostics.cjs');
const { diagnosticsFixture } = require('./fixtures/diagnostics.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('bootstrap progress accepts only finite stages and the actual child identity without raw data', () => {
  assert.deepEqual(parseNativeStartup('VI_STARTUP script-entry 42 8 5 Desktop', 42),
    { startupStage: 'script-entry', pointerBytes: 8, powerShellMajor: 5, powerShellEdition: 'Desktop' });
  for (const line of ['VI_STARTUP PRIVATE_PATH 42 8 5 Desktop', 'VI_STARTUP script-entry 99 8 5 Desktop',
    'VI_STARTUP script-entry 42 16 5 Desktop', 'VI_STARTUP script-entry 42 8 5 PRIVATE_EDITION']) {
    assert.equal(parseNativeStartup(line, 42), undefined);
  }
  const trace = new NativeTrace(undefined, 'delivery', 1);
  const child = Object.assign(new EventEmitter(), { pid: 42, stderr: new PassThrough() });
  trace.attach(child);
  child.stderr.write('VI_STARTUP script-');
  child.stderr.write('entry 42 8 5 Desktop\n');
  for (let i = 0; i < 30; i++) child.stderr.write('VI_STARTUP protocol-ready 42 8 5 Desktop\n');
  assert.equal(trace.startup.length, 16);
  assert.equal(trace.startup[0].startupStage, 'script-entry');
  assert.doesNotMatch(JSON.stringify(trace.startup), /PRIVATE/);
});

test('native diagnostics retain correlation and safe categories, never raw stderr or payload', async (t) => {
  const fixture = await diagnosticsFixture(t, 300);
  const { diagnostics } = fixture;
  const trace = new NativeTrace(diagnostics, 'pointer', 2);
  const child = Object.assign(new EventEmitter(), { pid: 123, stderr: new PassThrough() });
  trace.attach(child);
  child.stderr.write('PRIVATE_URL_TOKEN_PATH error CS1003\n');
  child.stderr.write('PRIVATE_OTHER error CS1003\n');
  child.stderr.write('VI_STARTUP script-entry 123 8 5 Desktop\n');
  diagnostics.record('native', { component: 'delivery', state: 'reply', clipboardStage: 'restore-write',
    clipboardFormat: 49465, formatName: 'PRIVATE_NATIVE_FORMAT' });
  diagnostics.record('native', { component: 'delivery', state: 'reply', clipboardStage: 'publication-state',
    clipboardFormat: 49466, formatName: 'PRIVATE_PUBLICATION_FORMAT' });
  child.stderr.write(`VI_DIAG ${JSON.stringify({ run: diagnostics.runId, pid: 123, generation: 2,
    state: 'suspended', monoMs: 15, time: '2026-01-01T00:00:00.000Z', birthFileTime: '134380000000000000',
    inputDesktop: 'unavailable', win32Error: 5, endpoint: 'PRIVATE_ENDPOINT' })}\n`);
  trace.closing = true;
  child.emit('exit', 0, null);
  const rows = await fixture.entries();
  const text = JSON.stringify(rows);
  assert.doesNotMatch(text, /PRIVATE|endpoint|PATH/);
  assert.equal(rows.filter((row) => row.fault === 'compilation').length, 1);
  assert.ok(rows.some((row) => row.clipboardStage === 'restore-write' && row.clipboardFormat === 49465));
  assert.ok(rows.some((row) => row.clipboardStage === 'publication-state' && row.clipboardFormat === 49466));
  assert.ok(rows.some((row) => row.startupStage === 'script-entry' && row.powerShellMajor === 5 &&
    row.powerShellEdition === 'Desktop' && row.pointerBytes === 8));
  assert.ok(rows.some((row) => row.generation === 2 && row.helperPid === 123 && row.nativeMonoMs === 15 && row.win32Error === 5));
  assert.equal(rows.at(-1).fault, 'owned-close');
});

test('native sampler persists one host pulse gap from controlled monotonic fixture state', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vi-native-gap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // Seed fixture bookkeeping, not the production stopwatch, threshold or writer.
  const script = `$ErrorActionPreference='Stop'\n. '${path.resolve('native', 'windows-diagnostics.ps1').replaceAll("'", "''")}'\n` +
    `Add-Type -TypeDefinition 'public static class GapSink { public static System.Action<string> Original; public static readonly System.Threading.ManualResetEventSlim Written = new System.Threading.ManualResetEventSlim(false); public static void Write(string line) { Original(line); if(line.Contains("host-gap")) Written.Set(); } }'\n` +
    `$type=[ViNativeDiagnostics];$flags=[Reflection.BindingFlags]'Static,NonPublic'\n` +
    `[GapSink]::Original=[Delegate]::CreateDelegate([Action[string]],$type.GetMethod('WriteLine',$flags))\n` +
    `$type.GetField('sink',$flags).SetValue($null,[Delegate]::CreateDelegate([Action[string]],[GapSink].GetMethod('Write')))\n` +
    `[ViNativeDiagnostics]::Configure('${root.replaceAll("'", "''")}','12345678-1234-1234-1234-123456789abc','pointer',1,$PID,$false)\n` +
    `$now=$type.GetField('clock',$flags).GetValue($null).ElapsedMilliseconds\n` +
    `$type.GetField('lastPulse',$flags).SetValue($null,[long]($now-5200))\n` +
    `$type.GetField('lastCheck',$flags).SetValue($null,[long]($now-1000))\n` +
    `[ViNativeDiagnostics]::Sample()\n[ViNativeDiagnostics]::Sample()\n` +
    `if(-not [GapSink]::Written.Wait(2000)){throw 'Actual native writer did not persist the controlled host-gap record.'}\n` +
    `[ViNativeDiagnostics]::Close()\n`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { timeout: 15000, stdio: 'pipe', env: nativeHelperEnvironment() });
  const rows = (await fs.readFile(path.join(root, 'native-pointer.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter((row) => row.state === 'host-gap').length, 1);
  assert.ok(rows.at(-1).hostGapMs >= 5000);
  assert.ok(rows.every((row) => row.pid > 0 && row.generation === 1 && row.birthFileTime && row.monoMs >= 0));
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('malformed native metadata is an explicit protocol category, not a trusted receipt', () => {
  const records = [];
  const diagnostics = { runId: '12345678-1234-1234-1234-123456789abc',
    record: (_event, data) => records.push(data), checkpoint: (_event, data) => records.push(data) };
  const trace = new NativeTrace(diagnostics, 'pointer', 1);
  const child = Object.assign(new EventEmitter(), { pid: 42, stderr: new PassThrough() });
  trace.attach(child);
  for (const data of [{ run: 'wrong', pid: 42, generation: 1 }, { run: diagnostics.runId, pid: 42,
    generation: 1, state: 'PRIVATE_STATE', monoMs: 0, birthFileTime: '134380000000000000' }]) {
    child.stderr.write(`VI_DIAG ${JSON.stringify(data)}\n`);
  }
  assert.equal(records.length, 2);
  assert.ok(records.every((entry) => entry.fault === 'protocol'));
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_STATE|wrong/);
});

test('a failed native sidecar remains component-local and does not disable lifecycle or fatal records', async (t) => {
  const fixture = await diagnosticsFixture(t);
  const { diagnostics } = fixture;
  const trace = new NativeTrace(diagnostics, 'pointer', 1);
  const child = Object.assign(new EventEmitter(), { pid: 42, stderr: new PassThrough() });
  trace.attach(child);
  child.stderr.write('VI_DIAGNOSTIC_FAILURE\nVI_DIAGNOSTIC_FAILURE\n');
  diagnostics.checkpoint('lifecycle', { component: 'main', state: 'uncaught-exception' });
  assert.equal(diagnostics.failed, undefined);
  const records = await fixture.entries();
  assert.equal(records.filter((row) => row.state === 'log-write-failed').length, 1);
  assert.ok(records.some((row) => row.state === 'uncaught-exception'));
});

test('slow and failing native sinks never block sampling or API-boundary producers', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vi-native-slow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = `$ErrorActionPreference='Stop'\n. '${path.resolve('native', 'windows-diagnostics.ps1').replaceAll("'", "''")}'\n` +
    `Add-Type -TypeDefinition 'public static class SlowSink { public static void Write(string line) { System.Threading.Thread.Sleep(600); } }'\n` +
    `$type=[ViNativeDiagnostics];$field=$type.GetField('sink',[Reflection.BindingFlags]'Static,NonPublic')\n` +
    `$sink=[Delegate]::CreateDelegate([Action[string]],[SlowSink].GetMethod('Write'));$field.SetValue($null,$sink)\n` +
    `[ViNativeDiagnostics]::Configure('${root.replaceAll("'", "''")}','12345678-1234-1234-1234-123456789abc','pointer',1,$PID,$false)\n` +
    `$clock=[Diagnostics.Stopwatch]::StartNew();1..30|ForEach-Object {[ViNativeDiagnostics]::Record('SetWindowPos','begin',0);[ViNativeDiagnostics]::Sample()}\n` +
    `if($clock.ElapsedMilliseconds -gt 250){throw 'Sampler/API producer waited for slow sink.'}\n[ViNativeDiagnostics]::Close()\n`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { timeout: 10000, stdio: 'pipe', env: nativeHelperEnvironment() });
  const failing = script.replace('System.Threading.Thread.Sleep(600);', 'throw new System.IO.IOException("PRIVATE_SYNTHETIC");');
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(failing, 'utf16le').toString('base64')], { timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'], env: nativeHelperEnvironment() });
  assert.doesNotMatch(result.toString(), /PRIVATE_SYNTHETIC/);
});

test('Windows CI helper generation resolves the shared script before optional desktop attestation', async () => {
  const source = await fs.readFile(path.resolve('scripts', 'overlay-recovery-ui.cjs'), 'utf8');
  const run = source.indexOf('async function run()');
  const start = source.indexOf("if (process.platform === 'win32') {", run) + "if (process.platform === 'win32') {".length;
  const end = source.indexOf('if (expectedDesktop) {', start);
  assert.ok(start > run && end > start);
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const generate = new AsyncFunction('fs', 'path', 'assert', 'unavailable', `${source.slice(start, end)}\nreturn injected;`);
  const injected = await generate(fs, path, assert, 'synthetic-unavailable');
  assert.ok(injected.includes(path.resolve('native', 'windows-diagnostics.ps1')));
  assert.match(injected, /if \(!ReadCursor\(out point\)\)/);
});

test('attested Windows helper generation resolves every production source from the native directory', async () => {
  const source = await fs.readFile(path.resolve('scripts', 'overlay-recovery-ui.cjs'), 'utf8');
  const run = source.indexOf('async function run()');
  const start = source.indexOf("  if (process.platform === 'win32') {", run);
  const end = source.indexOf('  const spawn = childProcess.spawn;', start);
  assert.ok(start > run && end > start);
  const files = new Map(), directory = path.resolve('synthetic-helper-output');
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const generate = new AsyncFunction('fs', 'path', 'assert', 'unavailable', 'expectedDesktop',
    'directory', 'desktopReceipt', 'process',
    `let helperFile, deliveryFile;\n${source.slice(start, end)}\nreturn {helperFile,deliveryFile};`);
  const names = await generate({ readFile: fs.readFile, writeFile: async (file, text) => files.set(file, text) },
    path, assert, 'synthetic-unavailable', 'vi-ci-1-1-' + 'a'.repeat(32),
    directory, path.join(directory, 'owned-job'), { platform: 'win32' });
  const delivery = files.get(names.deliveryFile);
  for (const name of ['windows-input.ps1', 'windows-diagnostics.ps1', 'windows-clipboard-snapshot.cs']) {
    assert.ok(delivery.includes(path.resolve('native', name)));
    assert.ok(!delivery.includes(`Join-Path $PSScriptRoot '${name}'`));
    assert.ok(!delivery.includes(`Combine($PSScriptRoot, '${name}')`));
  }
  assert.ok(files.get(names.helperFile).includes('VI_STARTUP ci-attest-begin'));
  assert.ok(delivery.includes('VI_STARTUP ci-attest-end'));
});
