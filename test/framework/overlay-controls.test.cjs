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
  return { calls, status, report: listeners.status,
    message: () => elements.get('message').textContent,
    detail: () => elements.get('.pill').title, interrupt: () => listeners.cancel(),
    nativeDown(name) { target = elements.get(name); listeners.down({ x: 0, y: 0 }); },
    click(name) { elements.get(name).onclick({ detail: 1 }); },
    pointer(name, event, properties = {}) {
      elements.get(name).listeners[event]?.({ pointerType: 'mouse', pointerId: 1, button: 0, buttons: 0, ...properties });
    },
    freshPress(name) {
      const button = elements.get(name);
      button.listeners.pointerdown?.({ pointerType: 'mouse', pointerId: 1, button: 0, buttons: 1 });
      button.listeners.pointerup?.({ pointerType: 'mouse', pointerId: 1, button: 0, buttons: 0 });
      button.onclick({ detail: 1, pointerId: 1 });
    },
  };
}

test('DOM-only quick clicks execute once even when the polling observer is ready or initially seeded held', () => {
  for (const name of ['stop', 'cancel']) {
    const f = fixture();
    f.status(true);
    f.freshPress(name);
    assert.equal(f.calls[name], 1);
    f.freshPress(name);
    assert.equal(f.calls[name], 2);
  }
});

test('native-first and DOM-first observations cannot duplicate a button gesture across readiness changes', () => {
  for (const name of ['stop', 'cancel']) {
    const f = fixture();
    f.status(true);
    f.nativeDown(name);
    f.pointer(name, 'pointerdown', { buttons: 1 });
    f.pointer(name, 'pointerup');
    assert.equal(f.calls[name], 1);
    f.interrupt();
    f.status(false);
    f.click(name);
    assert.equal(f.calls[name], 1, 'One physical press dispatched its action twice.');
    f.status(true);
    f.freshPress(name);
    f.nativeDown(name);
    assert.equal(f.calls[name], 2, 'A late polling observation repeated a completed DOM gesture.');
    f.freshPress(name);
    assert.equal(f.calls[name], 3, 'A separate gesture was incorrectly deduplicated.');
  }
});

test('the nonactivating first-click fallback owns pointerup without a DOM down and deduplicates its click', () => {
  const f = fixture();
  f.status(true);
  f.pointer('cancel', 'pointerenter');
  f.pointer('cancel', 'pointerup');
  assert.equal(f.calls.cancel, 1);
  f.interrupt();
  f.status(false);
  f.click('cancel');
  assert.equal(f.calls.cancel, 1);
  f.freshPress('cancel');
  assert.equal(f.calls.cancel, 2);
});

test('an unrelated native observation cannot drop a DOM-only click or cause a drag release to activate a button', () => {
  const f = fixture();
  f.status(true);
  f.click('stop');
  assert.equal(f.calls.stop, 1);
  f.nativeDown('stop');
  assert.equal(f.calls.stop, 1);
  f.pointer('stop', 'pointerenter', { buttons: 1 });
  f.pointer('stop', 'pointerup');
  assert.equal(f.calls.stop, 1);
});

test('provider setup errors have a distinct overlay label and retain the detailed failure', () => {
  const f = fixture();
  const message = "Provider setup failed: Cannot find module './missing-dependency.cjs'";
  f.report({ phase: 'error', errorKind: 'provider', message, elapsedSeconds: 0, nativePointer: false });
  assert.equal(f.message(), 'Provider setup error');
  assert.equal(f.detail(), message);
  f.report({ phase: 'error', errorKind: 'cloud', message: 'Connection refused',
    elapsedSeconds: 0, nativePointer: false });
  assert.equal(f.message(), 'Connection error');
});
