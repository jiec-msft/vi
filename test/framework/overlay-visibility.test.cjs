const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OverlayVisibility, overlayWindowOptions } = require('../../app/overlay-visibility.cjs');

function fixture() {
  let visible = false, top = true, bounds = { x: 900, y: 790, width: 240, height: 80 };
  let areas = [{ workArea: { x: 0, y: 0, width: 1000, height: 800 } }];
  const events = [], calls = [];
  const window = { isDestroyed: () => false, isVisible: () => visible, isAlwaysOnTop: () => top,
    getBounds: () => ({ ...bounds }), setBounds: (value) => { bounds = value; calls.push('bounds'); },
    setAlwaysOnTop: (value) => { top = value; }, showInactive: () => { visible = true; calls.push('showInactive'); },
    hide: () => { visible = false; calls.push('hide'); }, webContents: { reload: () => calls.push('reload') } };
  return { controller: new OverlayVisibility(window, () => areas, (event) => events.push(event)), calls, events,
    bounds: () => bounds, areas: (value) => { areas = value; } };
}
test('Windows uses an opaque compact nonactivating surface, without disabling GPU or sandbox', () => {
  const windows = overlayWindowOptions('win32');
  assert.equal(windows.transparent, false);
  assert.equal(windows.focusable, false);
  assert.equal(windows.width, 224);
  assert.equal(windows.height, 54);
  assert.equal(overlayWindowOptions('darwin').transparent, true);
});
test('display recovery clamps and resizes, but cannot undo an intentional user hide or focus input', () => {
  const f = fixture();
  f.controller.update(true, true);
  assert.deepEqual(f.calls, []);
  f.controller.displayChanged();
  assert.equal(f.calls.filter((value) => value === 'showInactive').length, 0);
  f.calls.length = 0;
  f.controller.update(true);
  assert.deepEqual(f.bounds(), { x: 776, y: 746, width: 224, height: 54 });
  f.controller.hideByUser();
  const shows = f.calls.filter((value) => value === 'showInactive').length;
  f.areas([{ workArea: { x: -800, y: -400, width: 800, height: 600 } }]);
  f.controller.displayChanged();
  f.controller.update(true);
  assert.equal(f.calls.filter((value) => value === 'showInactive').length, shows);
  f.controller.allow();
  f.controller.update(true);
  assert.equal(f.calls.filter((value) => value === 'showInactive').length, shows + 1);
  assert.ok(!f.calls.includes('focus'));
});
test('renderer recovery reloads only once, without show/hide flicker or restarting a recording', () => {
  const f = fixture();
  f.controller.update(true);
  f.calls.length = 0;
  f.controller.rendererGone();
  f.controller.rendererReady();
  assert.deepEqual(f.calls, ['reload']);
  assert.throws(() => f.controller.rendererGone(), /stopped repeatedly/);
});
