const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OverlayDrag, bindDragHandle } = require('../../app/overlay-drag.js');

function dragFixture() {
  let point = { x: 100, y: 100 }, bounds = { x: 50, y: 50, width: 224, height: 54 };
  const saved = [];
  const window = { isDestroyed: () => false, isVisible: () => true, getBounds: () => ({ ...bounds }),
    setPosition: (x, y) => { bounds = { ...bounds, x, y }; } };
  const drag = new OverlayDrag({ window, cursor: () => {
    if (point instanceof Error) throw point;
    return point;
  }, workArea: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
  persist: async (position) => saved.push(position) });
  return { drag, saved, window, point: (value) => { point = value; } };
}

test('cancel discards a gesture without resampling or persisting and allows the next drag', () => {
  const f = dragFixture();
  assert.equal(f.drag.start(), true);
  f.point(new Error('Cursor unavailable.'));
  f.drag.cancel();
  assert.equal(f.drag.active, false);
  assert.deepEqual(f.saved, []);
  f.point({ x: 200, y: 200 });
  assert.equal(f.drag.start(), true);
});

test('cursor failure on move or end cannot strand the anchor or save an invalid position', async () => {
  for (const action of ['move', 'finish']) {
    const f = dragFixture();
    f.drag.start();
    f.point(new Error('Cursor unavailable.'));
    if (action === 'finish') await assert.rejects(f.drag.finish(), /Cursor unavailable/);
    else assert.throws(() => f.drag.move(), /Cursor unavailable/);
    assert.equal(f.drag.active, false);
    assert.deepEqual(f.saved, []);
  }
});

test('drag follows cursor deltas, clamps to work area and persists a completed gesture', async () => {
  const f = dragFixture();
  f.drag.start();
  f.point({ x: 950, y: -100 });
  f.drag.move();
  assert.deepEqual(f.window.getBounds(), { x: 776, y: 0, width: 224, height: 54 });
  await f.drag.finish();
  assert.equal(f.drag.active, false);
  assert.deepEqual(f.saved, [{ x: 776, y: 0 }]);
});

function handleFixture(enabled = () => true) {
  const events = new Map(), actions = [], failures = [], frames = new Map();
  let capture, frameId = 0;
  const handle = {
    classList: { add() {}, remove() {} },
    addEventListener: (name, action) => events.set(name, action),
    setPointerCapture: (id) => { capture = id; },
    hasPointerCapture: (id) => id === capture,
    releasePointerCapture: () => { capture = undefined; },
  };
  const binding = bindDragHandle(handle, { drag: async (action) => {
    actions.push(action); return { ok: true, value: true };
  } }, (error) => failures.push(error), {
    requestAnimationFrame: (action) => { frames.set(++frameId, action); return frameId; },
    cancelAnimationFrame: (id) => frames.delete(id),
  }, enabled);
  const send = (name, changes = {}) => events.get(name)({
    pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, preventDefault() {}, ...changes,
  });
  return { binding, actions, failures, frames, send };
}

test('pointer cancellation does not complete a drag and drops pending movement', () => {
  const f = handleFixture();
  f.send('pointerdown');
  f.send('pointermove');
  f.send('pointercancel');
  f.send('lostpointercapture');
  assert.deepEqual(f.actions, ['start', 'cancel']);
  assert.equal(f.frames.size, 0);
});

test('readiness switching cancels DOM capture without starting a native gesture', () => {
  let enabled = true;
  const f = handleFixture(() => enabled);
  f.send('pointerdown');
  enabled = false;
  f.binding.cancel();
  f.send('pointermove');
  f.send('pointerup', { buttons: 0 });
  assert.deepEqual(f.actions, ['start', 'cancel']);
  assert.deepEqual(f.failures, []);
});

test('readiness cancellation clears an uncaptured hover before fallback sees a held mouse', () => {
  let enabled = true;
  const f = handleFixture(() => enabled);
  f.send('pointermove', { buttons: 0 });
  enabled = false;
  f.binding.cancel();
  enabled = true;
  f.binding.cancel();
  f.send('pointermove');
  assert.deepEqual(f.actions, []);
  assert.equal(f.frames.size, 0);
  f.send('pointermove', { buttons: 0 });
  f.send('pointerdown');
  f.send('pointerup', { buttons: 0 });
  assert.deepEqual(f.actions, ['start', 'end']);
});
