const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Diagnostics } = require('../../app/diagnostics.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vi-diagnostics-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const failures = [];
  const diagnostics = new Diagnostics(root, (error) => failures.push(error));
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
