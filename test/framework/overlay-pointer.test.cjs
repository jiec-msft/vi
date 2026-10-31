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
  assert.equal(f.process.killed, true);
});

test('invalid coordinates, unexpected releases and startup timeout cannot leave a stuck drag', async (t) => {
  for (const bad of [{ type: 'up', x: 0, y: 0 }, { type: 'down', x: NaN, y: 0 }, { type: 'down', x: 1000001, y: 0 }]) {
    const f = fixture(t);
    await f.send({ type: 'ready' });
    await f.send(bad);
    assert.equal(f.pointer.closed, true);
    assert.equal(f.failures.length, 1);
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  t.mock.timers.tick(8000);
  assert.equal(f.pointer.closed, true);
  assert.equal(f.failures.length, 1);
});
