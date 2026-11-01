const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { OverlayPointer } = require('../../app/overlay-pointer.cjs');

function fixture(t) {
  const process = new EventEmitter(), events = [], failures = [];
  Object.assign(process, { stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { this.killed = true; } });
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(1234n);
  const pointer = new OverlayPointer({ getNativeWindowHandle: () => handle },
    (event) => events.push(event), (error) => failures.push(error.message),
    (file, args, options) => {
      assert.equal(file, 'powershell.exe');
      assert.equal(options.windowsHide, true);
      assert.equal(args[args.indexOf('-Window') + 1], '1234');
      return process;
    });
  t.after(() => pointer.close());
  return { pointer, process, events, failures,
    send: async (event) => { process.stdout.write(`${JSON.stringify(event)}\n`); await nextTurn(); } };
}

test('native pointer handles an eaten mouse-down, moves outside the popup, and releases exactly once', async (t) => {
  const f = fixture(t);
  await f.send({ type: 'ready' });
  await f.send({ type: 'down', x: 100, y: 200 });
  assert.equal(f.pointer.pressed, true);
  await f.send({ type: 'move', x: -1800, y: 300 });
  await f.send({ type: 'up', x: -1800, y: 300 });
  assert.equal(f.pointer.pressed, false);
  assert.deepEqual(f.events.map((event) => event.type), ['ready', 'down', 'move', 'up']);
  assert.deepEqual(f.failures, []);
});

test('observer failure is visible, releases interaction state, and terminates only its owned process', async (t) => {
  const f = fixture(t);
  await f.send({ type: 'ready' });
  await f.send({ type: 'down', x: 100, y: 200 });
  f.process.emit('exit', 1);
  f.process.emit('error', new Error('untrusted detail'));
  assert.equal(f.failures.length, 1);
  assert.match(f.failures[0], /shortcut/);
  assert.equal(f.pointer.pressed, false);
  assert.equal(f.process.killed, undefined);
});

test('helper death clears readiness before notifying consumers and cancels a held gesture', async (t) => {
  const f = fixture(t);
  await f.send({ type: 'ready' });
  await f.send({ type: 'down', x: 100, y: 200 });
  f.process.emit('exit', 1);
  assert.equal(f.pointer.ready, false);
  assert.equal(f.pointer.state, 'recovering');
  assert.equal(f.events.at(-1).type, 'cancel');
});

test('temporary cursor loss suspends native input and requires a fresh press after readiness returns', async (t) => {
  const f = fixture(t);
  await f.send({ type: 'ready' });
  await f.send({ type: 'down', x: 100, y: 200 });
  await f.send({ type: 'cancel' });
  await f.send({ type: 'suspended' });
  assert.equal(f.pointer.ready, false);
  assert.equal(f.pointer.pressed, false);
  assert.equal(f.pointer.state, 'suspended');
  assert.equal(f.process.killed, undefined);
  await f.send({ type: 'ready' });
  assert.equal(f.pointer.ready, true);
  await f.send({ type: 'down', x: 120, y: 220 });
  await f.send({ type: 'up', x: 120, y: 220 });
  assert.deepEqual(f.failures, []);
});

test('a live suspended sampler survives a long disconnect without restarting or replaying input', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  await f.send({ type: 'ready' });
  await f.send({ type: 'down', x: 100, y: 200 });
  await f.send({ type: 'cancel' });
  await f.send({ type: 'suspended' });
  for (let second = 0; second < 120; second++) {
    t.mock.timers.tick(1000);
    await f.send({ type: 'heartbeat' });
  }
  assert.equal(f.pointer.state, 'suspended');
  assert.equal(f.pointer.ready, false);
  assert.equal(f.pointer.pressed, false);
  assert.equal(f.pointer.restarts, 0);
  assert.equal(f.process.killed, undefined);
  assert.deepEqual(f.failures, []);
  assert.deepEqual(f.events.map((event) => event.type), ['ready', 'down', 'cancel', 'suspended']);
  await f.send({ type: 'ready' });
  assert.equal(f.pointer.state, 'ready');
  assert.equal(f.pointer.pressed, false);
  await f.send({ type: 'down', x: 120, y: 220 });
  await f.send({ type: 'up', x: 120, y: 220 });
  assert.deepEqual(f.events.slice(-3).map((event) => event.type), ['ready', 'down', 'up']);
});

test('suspended liveness still times out at eight seconds and a heartbeat cannot fake startup readiness', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  await f.send({ type: 'suspended' });
  t.mock.timers.tick(7999);
  assert.equal(f.pointer.state, 'suspended');
  t.mock.timers.tick(1);
  assert.equal(f.pointer.state, 'recovering');
  assert.equal(f.process.killed, true);
  assert.equal(f.failures.length, 1);
  const starting = fixture(t);
  await starting.send({ type: 'heartbeat' });
  assert.equal(starting.pointer.ready, false);
  assert.equal(starting.pointer.state, 'recovering');
  assert.equal(starting.process.killed, true);
});

test('unexpected exit during healthy suspension still triggers failure and bounded recovery', async (t) => {
  const f = fixture(t);
  await f.send({ type: 'suspended' });
  await f.send({ type: 'heartbeat' });
  f.process.emit('exit', 1);
  assert.equal(f.pointer.state, 'recovering');
  assert.equal(f.pointer.ready, false);
  assert.equal(f.failures.length, 1);
});

test('recovery is bounded across ready-then-exit loops and shutdown cancels pending restart', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const children = [];
  const handle = Buffer.alloc(8);
  const failures = [];
  const pointer = new OverlayPointer({ getNativeWindowHandle: () => handle }, () => {},
    (error) => failures.push(error), () => {
      const child = new EventEmitter();
      Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
      children.push(child);
      return child;
    });
  t.after(() => pointer.close());
  for (const delay of [250, 1000, 3000, 0]) {
    const child = children.at(-1);
    child.stdout.write('{"type":"ready"}\n');
    child.emit('exit', 1);
    t.mock.timers.tick(delay);
  }
  assert.equal(children.length, 4);
  assert.equal(pointer.state, 'unavailable');
  assert.equal(pointer.ready, false);
  assert.equal(failures.length, 4);
  t.mock.timers.tick(60000);
  assert.equal(children.length, 4);
  pointer.close();
  assert.equal(pointer.state, 'closed');
});

test('invalid coordinates, unexpected releases and startup timeout cannot leave a stuck drag', async (t) => {
  for (const bad of [{ type: 'up', x: 0, y: 0 }, { type: 'down', x: NaN, y: 0 }, { type: 'down', x: 1000001, y: 0 }]) {
    const f = fixture(t);
    await f.send({ type: 'ready' });
    await f.send(bad);
    assert.equal(f.pointer.state, 'recovering');
    assert.equal(f.process.killed, true);
    assert.equal(f.failures.length, 1);
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  t.mock.timers.tick(8000);
  assert.equal(f.pointer.state, 'recovering');
  assert.equal(f.failures.length, 1);
});

test('a helper that cannot be reaped stops recovery rather than overlapping another child', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  await f.send({ type: 'ready' });
  await f.send({ type: 'down', x: 1000001, y: 0 });
  t.mock.timers.tick(2000);
  assert.equal(f.pointer.state, 'unavailable');
  assert.equal(f.failures.length, 2);
  f.process.emit('exit', 1);
  t.mock.timers.tick(60000);
  assert.equal(f.pointer.restarts, 0);
});

test('shutdown during retry and late output from a failed helper cannot restore readiness', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  await f.send({ type: 'ready' });
  f.process.emit('exit', 1);
  await f.send({ type: 'ready' });
  assert.equal(f.pointer.ready, false);
  f.pointer.close();
  t.mock.timers.tick(60000);
  assert.equal(f.pointer.state, 'closed');
  assert.equal(f.events.length, 1);
});
