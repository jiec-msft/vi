const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { NativeTrace } = require('../../app/native-diagnostics.cjs');
const { Diagnostics } = require('../../app/diagnostics.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('native diagnostics retain correlation and safe categories, never raw stderr or payload', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vi-native-log-'));
  const diagnostics = new Diagnostics(root, assert.fail);
  t.after(async () => { diagnostics.close(); await fs.rm(root, { recursive: true, force: true }); });
  const trace = new NativeTrace(diagnostics, 'pointer', 2);
  const child = Object.assign(new EventEmitter(), { pid: 123, stderr: new PassThrough() });
  trace.attach(child);
  child.stderr.write('PRIVATE_URL_TOKEN_PATH error CS1003\n');
  child.stderr.write('PRIVATE_OTHER error CS1003\n');
  child.stderr.write(`VI_DIAG ${JSON.stringify({ run: diagnostics.runId, pid: 123, generation: 2,
    state: 'suspended', monoMs: 15, time: '2026-01-01T00:00:00.000Z', birthFileTime: '134380000000000000',
    inputDesktop: 'unavailable', win32Error: 5, endpoint: 'PRIVATE_ENDPOINT' })}\n`);
  trace.closing = true;
  child.emit('exit', 0, null);
  await diagnostics.flush();
  const text = await fs.readFile(diagnostics.file, 'utf8');
  assert.doesNotMatch(text, /PRIVATE|endpoint|PATH/);
  const rows = text.trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter((row) => row.fault === 'compilation').length, 1);
  assert.ok(rows.some((row) => row.generation === 2 && row.helperPid === 123 && row.nativeMonoMs === 15 && row.win32Error === 5));
  assert.equal(rows.at(-1).fault, 'owned-close');
});

test('native sampler independently persists a host pulse gap without a main timer', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vi-native-gap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = `$ErrorActionPreference='Stop'\n. '${path.resolve('native', 'windows-diagnostics.ps1').replaceAll("'", "''")}'\n` +
    `[ViNativeDiagnostics]::Configure('${root.replaceAll("'", "''")}','12345678-1234-1234-1234-123456789abc','pointer',1,$PID,$false)\n` +
    `Start-Sleep -Milliseconds 5200\n[ViNativeDiagnostics]::Sample()\n[ViNativeDiagnostics]::Sample()\n[ViNativeDiagnostics]::Close()\n`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { timeout: 15000, stdio: 'pipe' });
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vi-sidecar-failure-'));
  const diagnostics = new Diagnostics(root, assert.fail);
  t.after(async () => { diagnostics.close(); await fs.rm(root, { recursive: true, force: true }); });
  const trace = new NativeTrace(diagnostics, 'pointer', 1);
  const child = Object.assign(new EventEmitter(), { pid: 42, stderr: new PassThrough() });
  trace.attach(child);
  child.stderr.write('VI_DIAGNOSTIC_FAILURE\nVI_DIAGNOSTIC_FAILURE\n');
  diagnostics.checkpoint('lifecycle', { component: 'main', state: 'uncaught-exception' });
  await diagnostics.flush();
  assert.equal(diagnostics.failed, undefined);
  const records = (await fs.readFile(diagnostics.file, 'utf8')).trim().split('\n').map(JSON.parse);
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
    Buffer.from(script, 'utf16le').toString('base64')], { timeout: 10000, stdio: 'pipe' });
  const failing = script.replace('System.Threading.Thread.Sleep(600);', 'throw new System.IO.IOException("PRIVATE_SYNTHETIC");');
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(failing, 'utf16le').toString('base64')], { timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
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
