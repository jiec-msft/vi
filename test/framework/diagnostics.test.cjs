const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Diagnostics } = require('../../app/diagnostics.cjs');
const { EventEmitter, once } = require('node:events');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vi-diagnostics-'));
  const failures = [];
  const diagnostics = new Diagnostics(root, (error) => failures.push(error));
  t.after(async () => { diagnostics.close(); await fs.rm(root, { recursive: true, force: true }); });
  // Content assertions do not impose a cold Worker startup deadline; timing tests below do.
  const ready = once(diagnostics.writer, 'message');
  diagnostics.writer.postMessage({ lines: [], seq: 0 });
  const [ack] = await ready;
  assert.equal(ack.seq, 0);
  return { diagnostics, async entries() {
    await diagnostics.flush();
    assert.deepEqual(failures, []);
    return (await fs.readFile(path.join(root, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  } };
}

test('startup diagnostics retain stable, preview and build versions without arbitrary strings', async (t) => {
  const f = await fixture(t);
  for (const version of ['0.6.1', '0.6.1-vi-preview', '0.6.1-preview.2+build.3', 'https://private.invalid/token', '1.2.3\nsecret']) {
    f.diagnostics.record('app-start', { version });
  }
  assert.deepEqual((await f.entries()).map((entry) => entry.version),
    ['0.6.1', '0.6.1-vi-preview', '0.6.1-preview.2+build.3', undefined, undefined]);
});

test('native pointer faults retain fixed reason and recovery state, never raw errors', async (t) => {
  const f = await fixture(t);
  for (const fault of ['spawn', 'exit', 'timeout', 'stream', 'protocol', 'dispatch', 'termination', 'private-token']) {
    f.diagnostics.record('error', { reason: `overlay-pointer-${fault}`, pointerState: 'recovering',
      pointerRestarts: 1, pointerPressed: false, error: 'PRIVATE_SYNTHETIC_ERROR' });
  }
  const entries = await f.entries();
  assert.deepEqual(entries.map((entry) => entry.reason), [
    'overlay-pointer-spawn', 'overlay-pointer-exit', 'overlay-pointer-timeout', 'overlay-pointer-stream',
    'overlay-pointer-protocol', 'overlay-pointer-dispatch', 'overlay-pointer-termination', undefined,
  ]);
  assert.ok(entries.every((entry) => entry.pointerState === 'recovering' && entry.pointerRestarts === 1 &&
    entry.pointerPressed === false));
  assert.doesNotMatch(JSON.stringify(entries), /PRIVATE|private-token/);
});

test('startup stages record bounded labels and elapsed time without paths or native content', async (t) => {
  const f = await fixture(t);
  for (const stage of ['preferences', 'login', 'plugins', 'windows', 'renderers', 'desktop', 'controls',
    'window-show', 'window-focus', 'window-order', 'PRIVATE_SYNTHETIC_PATH']) {
    f.diagnostics.record('startup-stage', { stage, state: 'begin', elapsedMs: 123, stderr: 'PRIVATE_SYNTHETIC_ERROR' });
    f.diagnostics.record('startup-stage', { stage, state: 'end', elapsedMs: 124 });
  }
  const entries = await f.entries();
  assert.ok(entries.slice(0, -2).every((entry) => entry.stage && ['begin', 'end'].includes(entry.state)));
  assert.equal(entries.at(-2).stage, undefined);
  assert.equal(entries.at(-1).stage, undefined);
  assert.doesNotMatch(JSON.stringify(entries), /PRIVATE|stderr/);
});

test('launch correlation and spans use a monotonic clock despite a backwards wall clock', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vi-clock-'));
  let mono = 100, wall = new Date('2026-01-01T00:00:00Z');
  const d = new Diagnostics(root, assert.fail, 524288, { clock: () => mono, wall: () => wall, pid: 123 });
  t.after(async () => { d.close(); await fs.rm(root, { recursive: true, force: true }); });
  d.metadata({ version: '0.6.2-preview', frameworkRevision: 'a'.repeat(40), assemblyRevision: 'b'.repeat(40),
    endpoint: 'PRIVATE_ENDPOINT', osVersion: '10.0.26300', arch: 'x64' });
  d.stage('window-show', 'begin');
  mono = 250; wall = new Date('2025-01-01T00:00:00Z');
  d.stage('window-show', 'end');
  await d.flush();
  const lines = (await fs.readFile(d.file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].run, lines[1].run);
  assert.equal(lines[0].pid, 123);
  assert.equal(lines[1].seq, lines[0].seq + 1);
  assert.equal(lines[1].spanMs, 150);
  assert.equal(lines[1].monoMs, 150);
  assert.equal(lines[1].buildInfoState, 'available');
  assert.doesNotMatch(JSON.stringify(lines), /PRIVATE_ENDPOINT/);
});

test('critical begin is independently visible while the main thread is deliberately blocked', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vi-block-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const module = require.resolve('../../app/diagnostics.cjs');
  const code = `const {Diagnostics}=require(${JSON.stringify(module)});
    const d=new Diagnostics(${JSON.stringify(root)},()=>{process.exitCode=2});
    d.stage('window-focus','begin'); process.stdout.write('BLOCK\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,800);
    d.stage('window-focus','end'); d.flush().then(()=>d.close());`;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  await new Promise((resolve) => child.stdout.once('data', resolve));
  let text = '';
  const until = performance.now() + 500;
  while (performance.now() < until) {
    try { text = await fs.readFile(path.join(root, 'events.jsonl'), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (text.includes('"state":"begin"')) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(text, /"state":"begin"/);
  assert.doesNotMatch(text, /"state":"end"/);
  assert.equal(await exited, 0);
});

test('a stalled writer bounds checkpoint, queue and exit flush without exposing raw errors', async (t) => {
  let writer;
  let lastSynchronousWrite;
  const failures = [];
  const d = new Diagnostics('unused', (error) => failures.push(error), 524288, {
    createWriter: () => {
      writer = new EventEmitter();
      writer.unref = () => {};
      writer.postMessage = () => { lastSynchronousWrite = performance.now(); };
      return writer;
    },
  });
  t.after(() => d.close());
  const before = performance.now();
  d.stage('window-show', 'begin');
  assert.ok(performance.now() - before < 150);
  for (let index = 0; index < 1000; index++) d.record('error', { error: 'PRIVATE_TOKEN' });
  assert.ok(d.pending.length + d.inflight.size <= 128);
  assert.ok(d.dropped > 0);
  const flushAt = performance.now();
  const cpuAt = process.cpuUsage();
  await d.flush();
  const elapsed = performance.now() - flushAt, cpu = process.cpuUsage(cpuAt);
  assert.ok(elapsed < 350, JSON.stringify({ elapsedMs: elapsed, processCpuMs: (cpu.user + cpu.system) / 1000,
    synchronousDrainMs: lastSynchronousWrite - flushAt, inflight: d.inflight.size, dropped: d.dropped }));
  assert.equal(failures.length, 1);
  writer.emit('error', new Error('PRIVATE_PATH'));
  assert.equal(failures.length, 2);
  assert.doesNotMatch(failures[0].message, /PRIVATE/);
});

test('saturated ordinary queues reserve critical/drop capacity without becoming an I/O failure', () => {
  const messages = [];
  let control;
  const d = new Diagnostics('unused', assert.fail, 524288, {
    createWriter: (data) => {
      control = new Int32Array(data.control);
      const writer = new EventEmitter();
      writer.unref = () => {};
      writer.postMessage = (message) => messages.push(message);
      return writer;
    },
  });
  for (let index = 0; index < 1000; index++) d.record('error');
  d.drain();
  d.checkpoint('startup-stage', { stage: 'window-show', state: 'begin' });
  assert.ok(d.inflight.size + d.pending.length <= 128);
  assert.ok(d.inflightBytes + d.pendingBytes <= 32768);
  assert.equal(d.failed, undefined);
  const entries = messages.flatMap((message) => (message.lines || []).map(JSON.parse));
  assert.ok(entries.some((entry) => entry.event === 'diagnostic-drop' && entry.dropped > 0));
  assert.ok(entries.some((entry) => entry.stage === 'window-show' && entry.state === 'begin'));
  Atomics.store(control, 0, d.sentSequence);
  d.reap();
  d.close();
});

test('signed and unsigned Windows exit codes preserve complete NTSTATUS values', async (t) => {
  const f = await fixture(t);
  for (const exitCode of [0xc0000005, 0xc0000409, -2147483648, 4294967295, 4294967296]) {
    f.diagnostics.record('lifecycle', { state: 'process-gone', exitCode });
  }
  assert.deepEqual((await f.entries()).map((entry) => entry.exitCode),
    [0xc0000005, 0xc0000409, -2147483648, 4294967295, undefined]);
});

test('rotation retains valid correlated records within four bounded files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vi-rotate-'));
  const d = new Diagnostics(root, assert.fail, 1024);
  t.after(async () => { d.close(); await fs.rm(root, { recursive: true, force: true }); });
  for (let index = 0; index < 40; index++) d.checkpoint('startup-stage', { stage: 'windows', state: 'begin' });
  await d.flush();
  const files = await fs.readdir(root);
  assert.ok(files.length <= 4 && files.includes('events.jsonl.3'));
  for (const file of files) {
    assert.ok((await fs.stat(path.join(root, file))).size <= 1024);
    const entries = (await fs.readFile(path.join(root, file), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(entries.every((entry) => entry.run === d.runId && entry.pid === process.pid && entry.seq > 0));
  }
});

test('real filesystem failure is reported once without trapping startup or close', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vi-io-failure-'));
  const invalid = path.join(root, 'not-a-directory');
  await fs.writeFile(invalid, 'synthetic');
  const failures = [];
  const d = new Diagnostics(invalid, (error) => failures.push(error));
  t.after(async () => { d.close(); await fs.rm(root, { recursive: true, force: true }); });
  d.stage('windows', 'begin');
  await d.flush();
  assert.equal(failures.length, 1);
  assert.equal(d.failed, true);
  d.close();
  assert.equal(failures.length, 1);
});

for (const promise of [false, true]) test(`fatal ${promise ? 'rejection' : 'exception'} retains default nonzero exit and safe marker`, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vi-fatal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const module = require.resolve('../../app/diagnostics.cjs');
  const code = `const {Diagnostics}=require(${JSON.stringify(module)});
    const d=new Diagnostics(${JSON.stringify(root)},()=>{});d.watchProcess();
    d.checkpoint('lifecycle',{component:'main',state:'boot'});
    setTimeout(()=>{${promise ? 'Promise.reject(new Error("PRIVATE_URL_TOKEN"))' : 'throw new Error("PRIVATE_URL_TOKEN")'}},100);`;
  const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
  const exit = await new Promise((resolve) => child.once('exit', resolve));
  assert.notEqual(exit, 0);
  const log = await fs.readFile(path.join(root, 'events.jsonl'), 'utf8');
  assert.match(log, promise ? /unhandled-rejection/ : /uncaught-exception/);
  assert.doesNotMatch(log, /PRIVATE_URL_TOKEN|stack|http/);
});
