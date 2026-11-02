const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FinalDesktopLifecycle } = require('../scripts/distribution-desktop-lifecycle.cjs');

function fixture(t, { publicationFailures = {}, closeError, waitError, destroyError, outputError, stalled = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-final-lifecycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'progress.jsonl'), append = fs.appendFileSync;
  t.mock.method(fs, 'appendFileSync', (target, line) => {
    const { stage } = JSON.parse(line);
    if (publicationFailures[stage]) throw publicationFailures[stage];
    return append(target, line);
  });
  const calls = [], report = { status: 'passed' };
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  const driver = { driver: { process: child }, close() {
    calls.push('close');
    assert.equal(child.listenerCount('exit'), calls.includes('deadline') ? 0 : 1);
    if (!stalled) setImmediate(() => {
      calls.push('wait');
      if (waitError) child.emit('error', waitError);
      else { child.exitCode = 0; child.emit('exit', 0, null); }
    });
    if (closeError) throw closeError;
  } };
  const lifecycle = new FinalDesktopLifecycle({ report,
    publish: (stage) => { calls.push(`publish:${stage}`); fs.appendFileSync(file, `${JSON.stringify({ stage })}\n`); },
    driver: () => driver, editor: () => ({ destroy() { calls.push('destroy'); if (destroyError) throw destroyError; } }),
    clearDeadline: () => calls.push('disarm'),
    output: (value) => { calls.push('output'); assert.equal(value, report); if (outputError) throw outputError; },
    exit: (code) => calls.push(`exit:${code}`),
  });
  return { lifecycle, calls, report, child };
}

for (const stage of ['cleanup', 'complete']) {
  test(`append failure at ${stage} cannot block helper close/wait, editor destroy or final exit`, async (t) => {
    const original = new Error('PRIVATE_OPERATION');
    const publication = Object.assign(new Error('PRIVATE_PROFILE_PATH'), { code: 'ENOSPC' });
    const f = fixture(t, { publicationFailures: { [stage]: publication } });
    await assert.rejects(f.lifecycle.finish(original), (failure) => {
      assert.ok(failure instanceof AggregateError);
      assert.deepEqual(failure.errors, [original, publication]);
      return true;
    });
    for (const action of ['close', 'wait', 'destroy', 'output', 'exit:1']) assert.ok(f.calls.includes(action));
    assert.ok(f.calls.indexOf('wait') < f.calls.indexOf('destroy'));
    assert.equal(f.report.helperExited, true);
    assert.equal(f.report.status, 'failed');
    assert.equal(f.report.lifecycleFailures[1].phase, stage);
    assert.equal(f.report.lifecycleFailures[1].errorCode, 'ENOSPC');
    assert.doesNotMatch(JSON.stringify(f.report), /PRIVATE/);
  });
}

test('deadline append and cleanup failures still attempt every synchronous deadline action and exit nonzero', (t) => {
  const publication = Object.assign(new Error('PRIVATE_APPEND'), { code: 'EACCES' });
  const close = new Error('PRIVATE_CLOSE'), destroy = new Error('PRIVATE_DESTROY');
  const f = fixture(t, { publicationFailures: { deadline: publication }, closeError: close, destroyError: destroy, stalled: true });
  f.calls.push('deadline');
  assert.throws(() => f.lifecycle.deadline(), (failure) => {
    assert.ok(failure instanceof AggregateError);
    assert.deepEqual(failure.errors.slice(1), [publication, close, destroy]);
    assert.equal(failure.errors[0].message, 'Final desktop deadline exceeded.');
    return true;
  });
  assert.deepEqual(f.calls, ['deadline', 'publish:deadline', 'close', 'destroy', 'disarm', 'output', 'exit:1']);
  assert.equal(f.report.status, 'failed');
  assert.notEqual(f.report.helperExited, true);
  assert.doesNotMatch(JSON.stringify(f.report), /PRIVATE/);
});

test('a sole complete-publication failure retains the same error and cannot exit zero', async (t) => {
  const error = Object.assign(new Error('PRIVATE_COMPLETE'), { code: 'ENOENT' });
  const f = fixture(t, { publicationFailures: { complete: error } });
  await assert.rejects(f.lifecycle.finish(), (failure) => failure === error);
  assert.equal(f.report.status, 'failed');
  assert.equal(f.report.helperExited, true);
  assert.equal(f.calls.at(-1), 'exit:1');
  assert.equal(f.report.lifecycleFailures[0].phase, 'complete');
});

test('operation, append, close, wait, destroy and output errors retain all original identities', async (t) => {
  const errors = ['operation', 'append', 'close', 'wait', 'destroy', 'output']
    .map((label) => new Error(`PRIVATE_${label}`));
  const f = fixture(t, { publicationFailures: { cleanup: errors[1] }, closeError: errors[2],
    waitError: errors[3], destroyError: errors[4], outputError: errors[5] });
  await assert.rejects(f.lifecycle.finish(errors[0]), (failure) => {
    assert.ok(failure instanceof AggregateError);
    assert.deepEqual(failure.errors, errors);
    return true;
  });
  assert.equal(f.calls.filter((call) => call === 'close').length, 1);
  assert.equal(f.calls.filter((call) => call === 'destroy').length, 1);
  assert.equal(f.calls.at(-1), 'exit:1');
  assert.equal(f.report.helperExited, false);
  assert.equal(f.report.status, 'failed');
  assert.doesNotMatch(JSON.stringify(f.report), /PRIVATE/);
});

test('native helper wait remains bounded at 2500 ms and cannot suppress remaining cleanup', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { stalled: true });
  const rejected = assert.rejects(f.lifecycle.finish(), /Owned final native helper did not exit/);
  t.mock.timers.tick(2500);
  await rejected;
  assert.equal(f.report.helperExited, false);
  assert.equal(f.child.listenerCount('exit'), 0);
  assert.ok(f.calls.includes('destroy'));
  assert.equal(f.calls.at(-1), 'exit:1');
});

test('deadline during a pending helper wait preserves the operation and does not retry mandatory actions', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = new Error('PRIVATE_OPERATION'), publication = new Error('PRIVATE_DEADLINE_APPEND');
  const f = fixture(t, { stalled: true, publicationFailures: { deadline: publication } });
  const finished = assert.rejects(f.lifecycle.finish(original), (failure) => {
    assert.ok(failure instanceof AggregateError);
    assert.equal(failure.errors[0], original);
    assert.ok(failure.errors.includes(publication));
    return true;
  });
  assert.throws(() => f.lifecycle.deadline(), (failure) => {
    assert.equal(failure.errors[0], original);
    assert.ok(failure.errors.includes(publication));
    return true;
  });
  t.mock.timers.tick(2500);
  await finished;
  for (const action of ['close', 'destroy', 'output', 'exit:1']) {
    assert.equal(f.calls.filter((value) => value === action).length, 1);
  }
  assert.equal(f.report.status, 'failed');
  assert.equal(f.report.helperExited, false);
});

test('early publication errors are not duplicated as operation wrappers', async (t) => {
  const first = new Error('PRIVATE_FIRST'), second = new Error('PRIVATE_SECOND');
  const f = fixture(t, { publicationFailures: { 'js-entry': first, 'imports-ready': second } });
  assert.equal(f.lifecycle.publish('js-entry'), false);
  assert.equal(f.lifecycle.publish('imports-ready'), false);
  const original = f.lifecycle.failure();
  await assert.rejects(f.lifecycle.finish(original), (failure) => {
    assert.equal(failure, original);
    assert.deepEqual(failure.errors, [first, second]);
    return true;
  });
  assert.equal(f.calls.at(-1), 'exit:1');
  assert.equal(f.report.lifecycleFailures.length, 2);
});

test('successful lifecycle requires actual helper exit before destroy, final report and exit zero', async (t) => {
  const f = fixture(t);
  await f.lifecycle.finish();
  assert.equal(f.report.status, 'passed');
  assert.equal(f.report.helperExited, true);
  assert.deepEqual(f.calls, ['publish:cleanup', 'close', 'wait', 'destroy', 'publish:complete', 'disarm', 'output', 'exit:0']);
});
