const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const listeners = {}, calls = { stop: 0, cancel: 0 };
  const elements = new Map();
  for (const id of ['wave', 'message', 'drag-handle', 'stop', 'cancel', '.pill', '.dot']) {
    elements.set(id, { disabled: false, classList: { toggle() {} }, setAttribute() {},
      listeners: {}, addEventListener(name, action) { this.listeners[name] = action; },
      closest: (selector) => selector === `#${id}` });
  }
  let target;
  const bridge = {
    onStatus: (action) => { listeners.status = action; },
    onMeter: (action) => { listeners.meter = action; },
    onPointerDown: (action) => { listeners.down = action; },
    onPointerCancel: (action) => { listeners.cancel = action; },
    stop: async () => { calls.stop++; return { ok: true }; },
    cancel: async () => { calls.cancel++; return { ok: true }; },
    drag: async () => ({ ok: true, value: true }),
  };
  vm.runInNewContext(readFileSync(path.resolve('app', 'overlay.js'), 'utf8'), {
    VoiceWaveform: class { reset() {} draw() {} },
    bindDragHandle: () => ({ cancel() {} }),
    document: {
      getElementById: (id) => elements.get(id),
      querySelector: (id) => elements.get(id),
      elementFromPoint: () => target,
    },
    window: { floatingVoice: bridge },
  });
  const status = (nativePointer) => listeners.status({ nativePointer, phase: 'idle', elapsedSeconds: 0 });
  return { calls, status, interrupt: () => listeners.cancel(),
    nativeDown(name) { target = elements.get(name); listeners.down({ x: 0, y: 0 }); },
    click(name) { elements.get(name).onclick({ detail: 1 }); },
    freshPress(name) {
      const button = elements.get(name);
      button.listeners.pointerdown?.({ pointerType: 'mouse', button: 0, buttons: 1 });
      button.onclick({ detail: 1 });
    },
  };
}

test('native Stop and Cancel own their pending DOM click across helper cancellation and readiness changes', () => {
  for (const name of ['stop', 'cancel']) {
    const f = fixture();
    f.status(true);
    f.nativeDown(name);
    assert.equal(f.calls[name], 1);
    f.interrupt();
    f.status(false);
    f.click(name);
    assert.equal(f.calls[name], 1, 'One physical press dispatched its action twice.');
    f.freshPress(name);
    assert.equal(f.calls[name], 2, 'The next fallback press was incorrectly suppressed.');
  }
});

test('an unclicked native press cannot suppress a fresh fallback press', () => {
  const f = fixture();
  f.status(true);
  f.nativeDown('cancel');
  f.interrupt();
  f.status(false);
  f.freshPress('cancel');
  assert.equal(f.calls.cancel, 2);
});
