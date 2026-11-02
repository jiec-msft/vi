const { test } = require('node:test');
const assert = require('node:assert/strict');
const { autoCopyPreview } = require('../../app/transcript-output.cjs');
const { nativeHelperEnvironment } = require('../../app/native-diagnostics.cjs');

test('auto-copy cannot overwrite a concurrent user copy after targeted delivery, failure or cancellation', () => {
  for (const outcome of ['requested', 'clipboard-busy', 'clipboard-format', 'clipboard-changed', 'restore-failed', 'cancelled']) {
    assert.equal(autoCopyPreview({ autoCopy: true, target: { pid: 123 }, outcome }), false);
  }
  assert.equal(autoCopyPreview({ autoCopy: true }), true);
  assert.equal(autoCopyPreview({ autoCopy: false }), false);
});
test('Windows helper environment restores native module resolution without changing user or parent state', () => {
  const parent = { PATH: 'owned-path', PSModulePath: 'foreign-runtime', PSMODULEPATH: 'other-runtime' };
  assert.deepEqual(nativeHelperEnvironment(parent), { PATH: 'owned-path' });
  assert.equal(parent.PSModulePath, 'foreign-runtime');
});
