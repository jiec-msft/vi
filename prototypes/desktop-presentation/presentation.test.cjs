'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  MAX_SAMPLE_AGE_MS, WINDOW_POLICY, physicalRect, uiaCaretRect, axCaretRect,
  planCaret, CaretPresentation, planDock,
} = require('./presentation.cjs');

function fixture() {
  const monitor = {
    id: 'synthetic-left', scale: 1.5,
    bounds: { x: -1920, y: -200, width: 1920, height: 1080 },
    workArea: { x: -1920, y: -200, width: 1920, height: 1020 },
  };
  const sample = {
    targetKey: 'synthetic-field-generation-1', focusRevision: 1, topologyRevision: 1,
    permission: 'granted', fieldSecurity: 'plain', integrity: 'same', delivery: 'eligible',
    active: true, visible: true, capability: 'available', observedAt: 1000,
    monitorId: monitor.id,
    rect: { x: -1000, y: 200, width: 0, height: 24, space: 'screen-physical' },
  };
  const context = {
    now: 1000, recording: true, targetKey: sample.targetKey,
    focusRevision: 1, topologyRevision: 1, monitors: [monitor],
  };
  const dock = {
    mode: 'docked-window', capability: 'available', now: 1000, topologyRevision: 1,
    monitor, sizeDip: { width: 88, height: 44 },
    snapshot: {
      observedAt: 1000, topologyRevision: 1, monitorId: monitor.id, fullscreen: false,
      autoHide: 'disabled', edge: 'bottom', space: 'screen-physical',
      taskbar: { x: -1920, y: 820, width: 1920, height: 60 },
    },
  };
  return { monitor, sample, context, dock };
}

test('physical geometry rejects unknown/client/logical coordinates and invalid bounds', () => {
  for (const space of ['client-logical', 'screen-logical', 'ax-screen-points', undefined]) {
    assert.equal(physicalRect({ x: 0, y: 0, width: 0, height: 20, space }).status, 'blocked');
  }
  for (const rect of [null, {}, { x: NaN }, { x: 0, y: 0, width: -1, height: 20 },
    { x: 0, y: 0, width: 1, height: 0 }, { x: 1e308, y: 0, width: 1e308, height: 20 }]) {
    assert.equal(physicalRect(rect && { ...rect, space: 'screen-physical' }).status, 'blocked');
  }
  assert.deepEqual(physicalRect({ x: -1200, y: -200, width: 0, height: 20, space: 'screen-physical' }),
    { status: 'available', rect: { x: -1200, y: -200, width: 0, height: 20 } });
});

test('UIA empty, inactive and multiline ranges never invent a caret from adjacent text', () => {
  for (const values of [[], null, [1, 2], [0, 0, 1, 20, 0, 20, 1, 20], [0, 0, NaN, 20]]) {
    assert.equal(uiaCaretRect(values, true).status, 'blocked');
  }
  assert.equal(uiaCaretRect([10, 20, 0, 20], false).reason, 'inactive-caret');
  assert.equal(uiaCaretRect([10, 20, 0, 20], true).status, 'available');
});

test('AX transforms use display-local points and pixel origins, not a global Retina multiplier', () => {
  const display = {
    axBounds: { x: -1000, y: -100, width: 1000, height: 800 },
    pixelBounds: { x: -2000, y: -200, width: 2000, height: 1600 }, scale: 2,
  };
  const rect = { x: -900, y: 20, width: 0, height: 12, space: 'ax-screen-points' };
  assert.deepEqual(axCaretRect(rect, display).rect, { x: -1800, y: 40, width: 0, height: 24 });
  const other = {
    axBounds: { x: 0, y: 0, width: 1000, height: 800 },
    pixelBounds: { x: 0, y: 0, width: 1000, height: 800 }, scale: 1,
  };
  assert.deepEqual(axCaretRect({ ...rect, x: 100 }, other).rect,
    { x: 100, y: 20, width: 0, height: 12 });
  assert.equal(axCaretRect({ ...rect, x: -1, width: 2 }, display).status, 'blocked');
  assert.equal(axCaretRect(rect, { ...display, scale: 1 }).status, 'blocked');
  assert.equal(axCaretRect(rect, null).status, 'blocked');
});

test('caret placement uses the destination monitor scale without exposing target identity', () => {
  const { sample, context } = fixture();
  const plan = planCaret(sample, context);
  assert.deepEqual(plan.rect, { x: -1018, y: 233, width: 36, height: 42 });
  assert.equal(plan.action, 'show');
  assert.equal(plan.space, 'screen-physical');
  assert.equal('targetKey' in plan, false);
  assert.equal(plan.windowPolicy, WINDOW_POLICY);
  assert.equal(plan.appearance.animation, 'none');
});

test('caret flips above/side at edges instead of clamping away from destination', () => {
  const { sample, context } = fixture();
  assert.equal(planCaret({ ...sample, rect: { ...sample.rect, y: 796 } }, context).rect.y, 745);
  assert.equal(planCaret({ ...sample, rect: { ...sample.rect, x: -1920 } }, context).rect.x, -1911);
  assert.equal(planCaret({ ...sample, rect: { ...sample.rect, x: -1 } }, context).rect.x, -46);
  const small = { ...context.monitors[0], workArea: { x: -1000, y: 200, width: 10, height: 24 } };
  assert.equal(planCaret(sample, { ...context, monitors: [small] }).reason, 'no-adjacent-space');
  assert.equal(planCaret({ ...sample, rect: { ...sample.rect, x: 10 } }, context).reason,
    'caret-outside-work-area');
});

test('caret safety is explicit and fail-closed for every permission/identity capability gate', () => {
  const { sample, context } = fixture();
  const cases = [
    ['permission', 'denied', 'permission-unavailable'],
    ['permission', undefined, 'permission-unavailable'],
    ['fieldSecurity', 'password', 'secure-or-unknown-field'],
    ['fieldSecurity', 'unknown', 'secure-or-unknown-field'],
    ['integrity', 'elevated', 'integrity-unavailable'],
    ['integrity', 'unknown', 'integrity-unavailable'],
    ['delivery', 'skipped', 'delivery-blocked'],
    ['delivery', undefined, 'delivery-blocked'],
    ['active', false, 'inactive-target'], ['visible', false, 'inactive-target'],
    ['capability', 'unsupported', 'caret-unavailable'],
    ['targetKey', 'different', 'target-changed'],
    ['focusRevision', 2, 'focus-changed'], ['topologyRevision', 2, 'topology-changed'],
    ['monitorId', 'removed', 'monitor-unavailable'],
  ];
  for (const [key, value, reason] of cases) {
    assert.equal(planCaret({ ...sample, [key]: value }, context).reason, reason, key);
  }
  assert.equal(planCaret(sample, { ...context, recording: false }).reason, 'not-recording');
  assert.equal(planCaret(null, context).reason, 'missing-target');
  assert.equal(planCaret(sample, { ...context, monitors: [context.monitors[0], context.monitors[0]] }).reason,
    'monitor-unavailable');
});

test('sample expiration is exactly 250ms; future and invalid clock observations hide', () => {
  const { sample, context, dock } = fixture();
  assert.equal(MAX_SAMPLE_AGE_MS, 250);
  for (const age of [0, 249, 250]) {
    assert.equal(planCaret(sample, { ...context, now: 1000 + age }).action, 'show');
    assert.equal(planDock({ ...dock, now: 1000 + age }).action, 'show');
  }
  for (const now of [999, 1251, Infinity, NaN]) {
    assert.equal(planCaret(sample, { ...context, now }).reason, 'stale-target');
    assert.equal(planDock({ ...dock, now }).reason, 'stale-shell-state');
  }
});

test('asynchronous results cannot resurrect an invalidated, stopped or disposed target', () => {
  const { sample, context } = fixture();
  const session = new CaretPresentation();
  assert.equal(session.request().status, 'blocked');
  session.begin(sample.targetKey);
  const first = session.request();
  const latest = session.request();
  assert.equal(session.accept(first, sample).reason, 'obsolete-query');
  assert.equal(session.accept(latest, sample).status, 'accepted');
  assert.equal(session.accept(latest, sample).reason, 'obsolete-query');
  assert.equal(session.plan(context).action, 'show');
  const pending = session.request();
  assert.equal(session.invalidate('selection-moved').action, 'hide');
  assert.equal(session.accept(pending, sample).reason, 'obsolete-query');
  assert.equal(session.plan(context).reason, 'selection-moved');
  assert.equal(session.accept(session.request(), sample).status, 'accepted');
  assert.equal(session.plan(context).action, 'show');
  const beforeStop = session.request();
  session.stop();
  assert.equal(session.accept(beforeStop, sample).reason, 'obsolete-query');
  session.begin(sample.targetKey);
  assert.equal(session.accept(beforeStop, sample).reason, 'obsolete-query');
  const beforeDispose = session.request();
  session.dispose();
  assert.equal(session.accept(beforeDispose, sample).reason, 'obsolete-query');
  assert.equal(session.plan(context).reason, 'disposed');
  assert.throws(() => session.begin(sample.targetKey), /disposed/);
});

test('session never retargets on focus switch, clears expired data and snapshots caller data', () => {
  const { sample, context } = fixture();
  const session = new CaretPresentation();
  session.begin(sample.targetKey);
  session.accept(session.request(), sample);
  sample.rect.x = 100;
  assert.equal(session.plan(context).action, 'show');
  assert.equal(session.plan({ ...context, targetKey: 'different' }).reason, 'target-changed');
  assert.equal(session.plan(context).action, 'hide');
  assert.equal(session.accept(session.request(), { ...sample, targetKey: 'different' }).status, 'blocked');
  sample.rect.x = -1000;
  session.accept(session.request(), sample);
  assert.equal(session.plan({ ...context, now: 1251 }).reason, 'stale-target');
  assert.equal(session.plan(context).action, 'hide');
  session.accept(session.request(), sample);
  assert.equal(session.plan({ ...context, now: 1100 }).reason, 'clock-invalid');
  assert.throws(() => session.invalidate(''), /reason/);
  assert.throws(() => session.begin(''), /required/);
});

test('docking preserves floating mode and never silently replaces unsupported native embedding', () => {
  const { dock } = fixture();
  assert.deepEqual(planDock({ mode: 'floating' }), { action: 'unchanged', presentation: 'floating' });
  assert.equal(planDock({ ...dock, mode: 'native-taskbar' }).reason, 'native-taskbar-slot-unsupported');
  assert.equal(planDock({ ...dock, mode: 'unknown' }).reason, 'unknown-presentation-mode');
  assert.equal(planDock({ ...dock, capability: 'unknown' }).reason, 'nonactivating-window-unavailable');
  const plan = planDock(dock);
  assert.deepEqual(plan.rect, { x: -144, y: 742, width: 132, height: 66 });
  assert.equal(plan.presentation, 'docked-window');
  assert.equal(plan.anchor, 'work-area-corner');
  assert.match(plan.label, /not taskbar embedded/);
  assert.equal(plan.windowPolicy.accessibility, 'status-only');
});

test('docking hides for fullscreen, auto-hide (even revealed), unknown and inconsistent shell state', () => {
  const { dock } = fixture();
  for (const fullscreen of [true, undefined]) {
    assert.equal(planDock({ ...dock, snapshot: { ...dock.snapshot, fullscreen } }).reason,
      'fullscreen-or-unknown');
  }
  for (const autoHide of ['hidden', 'revealed', undefined]) {
    assert.equal(planDock({ ...dock, snapshot: { ...dock.snapshot, autoHide } }).reason,
      'autohide-or-unknown');
  }
  for (const [key, value, reason] of [
    ['monitorId', 'removed', 'monitor-unavailable'], ['topologyRevision', 2, 'topology-changed'],
    ['edge', 'unknown', 'unknown-taskbar-edge'], ['space', 'screen-logical', 'physical-geometry-required'],
    ['taskbar', null, 'taskbar-geometry-unavailable'],
    ['taskbar', { x: -1920, y: 800, width: 1920, height: 60 }, 'inconsistent-shell-geometry'],
  ]) {
    assert.equal(planDock({ ...dock, snapshot: { ...dock.snapshot, [key]: value } }).reason, reason);
  }
  assert.equal(planDock({ ...dock, sizeDip: { width: 20, height: 20 } }).reason, 'invalid-accessible-size');
  assert.equal(planDock({ ...dock, sizeDip: { width: 2000, height: 44 } }).reason, 'no-docking-space');
});

test('all taskbar edges, resize and monitor-scale changes recompute work-area-contained alternatives', () => {
  for (const scale of [1, 1.25, 1.5, 2, 3]) {
    for (const edge of ['bottom', 'top', 'left', 'right']) {
      const { dock } = fixture();
      dock.monitor.scale = scale;
      const b = dock.monitor.bounds;
      const thickness = Math.ceil(40 * scale);
      const horizontal = edge === 'bottom' || edge === 'top';
      dock.snapshot.edge = edge;
      dock.snapshot.taskbar = {
        x: edge === 'right' ? b.x + b.width - thickness : b.x,
        y: edge === 'bottom' ? b.y + b.height - thickness : b.y,
        width: horizontal ? b.width : thickness,
        height: horizontal ? thickness : b.height,
      };
      dock.monitor.workArea = {
        x: b.x + (edge === 'left' ? thickness : 0),
        y: b.y + (edge === 'top' ? thickness : 0),
        width: b.width - (horizontal ? 0 : thickness),
        height: b.height - (horizontal ? thickness : 0),
      };
      const plan = planDock(dock);
      assert.equal(plan.action, 'show', `${edge}/${scale}`);
      assert.equal(plan.rect.width, Math.ceil(88 * scale));
      assert.equal(plan.rect.height, Math.ceil(44 * scale));
      const w = dock.monitor.workArea;
      assert.ok(plan.rect.x >= w.x && plan.rect.y >= w.y &&
        plan.rect.x + plan.rect.width <= w.x + w.width &&
        plan.rect.y + plan.rect.height <= w.y + w.height);
      assert.equal(plan.windowPolicy.activate, false);
      assert.equal(plan.windowPolicy.focusable, false);
      assert.equal(plan.windowPolicy.pointer, 'passthrough');
      assert.equal(plan.windowPolicy.targetText, 'unchanged');
      assert.equal(plan.windowPolicy.finalDelivery, 'unchanged');
    }
  }
});

test('a returned placement cannot mutate global focus-preserving policy', () => {
  assert.throws(() => { WINDOW_POLICY.activate = true; }, TypeError);
  assert.ok(Object.isFrozen(WINDOW_POLICY));
});
