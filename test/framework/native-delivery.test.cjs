const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { readFileSync } = require('node:fs');
const { setImmediate: nextTurn } = require('node:timers/promises');
const vm = require('node:vm');

function fixture() {
  const child = new EventEmitter(), commands = [];
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdin.on('data', (data) => commands.push(JSON.parse(data.toString())));
  child.kill = () => { child.killed = true; };
  const context = vm.createContext({ module: { exports: {} },
    require: (name) => name === 'node:child_process' ? { spawn: () => child }
      : name === './native-diagnostics.cjs' ? require('../../app/native-diagnostics.cjs')
        : name === './clipboard-faults.cjs' ? require('../../app/clipboard-faults.cjs') : require(name),
    setTimeout, clearTimeout, process });
  vm.runInContext(readFileSync(require.resolve('../../app/native-delivery.cjs'), 'utf8'), context);
  const driver = new context.module.exports.NativeDelivery('win32', 'owned-resources');
  return { driver, child, commands, reply: (value) => child.stdout.write(`${JSON.stringify(value)}\n`) };
}

test('native clipboard and key queries are serialized on one helper', async () => {
  const f = fixture();
  try {
    const first = f.driver.request('ready'), second = f.driver.request('held', { keys: [17, 32] });
    await nextTurn();
    assert.equal(f.commands.length, 1);
    f.reply({ id: 1, ok: true, value: { ready: true } });
    await first;
    await nextTurn();
    assert.equal(f.commands.length, 2);
    f.reply({ id: 2, ok: true, value: { held: false } });
    assert.equal((await second).held, false);
  } finally { f.driver.close(); }
});
test('native failures expose only fixed messages, not raw helper content', async () => {
  const f = fixture();
  try {
    const pending = f.driver.request('paste', { text: 'owned synthetic transcript' });
    await nextTurn();
    f.reply({ id: 1, ok: false, code: 'restore-failed', error: 'PRIVATE_TOKEN_OR_TRANSCRIPT' });
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 'restore-failed');
      assert.doesNotMatch(error.message, /PRIVATE/);
      assert.match(error.message, /clipboard could not be restored/);
      return true;
    });

  } finally { f.driver.close(); }
});

test('clipboard preparation failures distinguish lock, unsupported format and backup failure without logging payloads', async () => {
  for (const [code, message] of [
    ['clipboard-busy', /holding the clipboard/],
    ['clipboard-format', /preserve every clipboard format/],
    ['clipboard-snapshot-failed', /safe clipboard backup/],
  ]) {
    const f = fixture();
    try {
      const request = f.driver.request('paste', { text: 'Approved fixture result' });
      await nextTurn();
      f.reply({ id: 1, ok: false, code, errorNumber: 5, pasteRequested: false, format: 'PRIVATE_FORMAT' });
      await assert.rejects(request, (error) => {
        assert.equal(error.code, code);
        assert.equal(error.errorNumber, 5);
        assert.equal(error.pasteRequested, false);
        assert.match(error.message, message);
        assert.doesNotMatch(error.message, /PRIVATE/);
        return true;
      });

    } finally { f.driver.close(); }
  }
});

test('clipboard fault metadata retains only fixed stages and numeric formats', async () => {
  for (const [stage, format] of [['restore-write', 49123], ['restore-text', 1], ['restore-close', 0], ['publication-state', 49124],
    ['snapshot-format', 49125], ['snapshot-format-name', 49126], ['snapshot-copy', 13], ['snapshot-release', 13],
    ['PRIVATE_FORMAT', 'PRIVATE_CONTENT']]) {
    const f = fixture();
    try {
      const request = f.driver.request('paste');
      await nextTurn();
      f.reply({ id: 1, ok: false, code: 'restore-failed', clipboardStage: stage, clipboardFormat: format });
      await assert.rejects(request, (error) => {
        assert.equal(error.clipboardStage, stage === 'PRIVATE_FORMAT' ? undefined : stage);
        assert.equal(error.clipboardFormat, typeof format === 'number' ? format : undefined);
        assert.doesNotMatch(error.message, /PRIVATE/);
        return true;
      });
    } finally { f.driver.close(); }
  }
});

test('validation and close causes survive the wire separately from cleanup without raw fields', async () => {
  const f = fixture();
  const causes = [
    { code: 'clipboard-changed', stage: 'publication-state', format: 13, errorNumber: 0 },
    { code: 'clipboard-unavailable', stage: 'publication-close', format: 0, errorNumber: 0 },
  ];
  const cleanup = [{ code: 'restore-failed', stage: 'restore-sequence', format: 0, errorNumber: 0 }];
  try {
    const pending = f.driver.request('paste');
    await nextTurn();
    f.reply({ id: 1, ok: false, code: 'restore-failed',
      clipboardCauses: causes.map((cause) => ({ ...cause, message: 'PRIVATE_TOKEN_METADATA' })),
      clipboardCleanupCauses: cleanup, clipboardCausesTruncated: false, clipboardCleanupCausesTruncated: true });
    await assert.rejects(pending, (error) => {
      assert.equal(JSON.stringify(error.clipboardCauses), JSON.stringify(causes));
      assert.equal(JSON.stringify(error.clipboardCleanupCauses), JSON.stringify(cleanup));
      assert.equal(error.clipboardCausesTruncated, false);
      assert.equal(error.clipboardCleanupCausesTruncated, true);
      assert.doesNotMatch(JSON.stringify(error.clipboardCauses), /PRIVATE|message/);
      return true;
    });
  } finally { f.driver.close(); }
});

test('snapshot classification and copy release causes retain fixed policy and both errors without raw fields', async () => {
  for (const causes of [
    [{ code: 'clipboard-format', stage: 'snapshot-format', format: 49125, errorNumber: 0 }],
    [{ code: 'clipboard-snapshot-failed', stage: 'snapshot-format-name', format: 49126, errorNumber: 87 }],
    [
      { code: 'clipboard-snapshot-failed', stage: 'snapshot-copy', format: 13, errorNumber: 0 },
      { code: 'clipboard-snapshot-failed', stage: 'snapshot-release', format: 13, errorNumber: 0 },
    ],
    [
      { code: 'restore-failed', stage: 'restore-copy', format: 13, errorNumber: 0 },
      { code: 'restore-failed', stage: 'snapshot-release', format: 13, errorNumber: 0 },
    ],
    [
      { code: 'restore-failed', stage: 'restore-write', format: 49125, errorNumber: 0 },
      { code: 'restore-failed', stage: 'restore-text', format: 1, errorNumber: 0 },
    ],
    [
      { code: 'restore-failed', stage: 'restore-write', format: 49125, errorNumber: 0 },
      { code: 'restore-failed', stage: 'restore-close', format: 0, errorNumber: 0 },
    ],
  ]) {
    const f = fixture();
    try {
      const pending = f.driver.request('paste');
      await nextTurn();
      f.reply({ id: 1, ok: false, code: causes[0].code, clipboardStage: causes[0].stage,
        clipboardFormat: causes[0].format, errorNumber: causes[0].errorNumber,
        clipboardCauses: causes.map((cause) => ({ ...cause, message: 'PRIVATE_COPY_OR_RELEASE',
          innerException: { message: 'PRIVATE_ORIGINAL_EXCEPTION' }, formatName: 'PRIVATE_FORMAT' })) });
      await assert.rejects(pending, (error) => {
        assert.equal(error.code, causes[0].code);
        assert.equal(error.clipboardStage, causes[0].stage);
        assert.equal(error.clipboardFormat, causes[0].format);
        assert.equal(error.errorNumber, causes[0].errorNumber);
        assert.equal(JSON.stringify(error.clipboardCauses), JSON.stringify(causes));
        assert.doesNotMatch(JSON.stringify(error.clipboardCauses), /PRIVATE|message|innerException|formatName/);
        return true;
      });
    } finally { f.driver.close(); }
  }
});

test('invalid cause schemas are protocol failures, not silently truncated success-shaped metadata', async () => {
  for (const clipboardCauses of [
    [{ code: 'PRIVATE_VALUE', stage: 'publication-state', format: 13, errorNumber: 0 }],
    Array.from({ length: 3 }, () => ({ code: 'native-error', stage: 'unspecified', format: 0, errorNumber: 0 })),
  ]) {
    const f = fixture();
    const pending = f.driver.request('paste');
    await nextTurn();
    f.reply({ id: 1, ok: false, code: 'restore-failed', clipboardCauses });
    await assert.rejects(pending, /invalid response/);
    assert.equal(f.child.killed, true);
  }
});

test('malformed native responses reject the request and terminate only the owned helper', async () => {
  const f = fixture();
  const pending = f.driver.request('ready');
  await nextTurn();
  f.reply({ id: 1, ok: 'true', value: {} });
  await assert.rejects(pending, /invalid response/);
  assert.equal(f.child.killed, true);
  await assert.rejects(f.driver.request('ready'), /closed/);
});

test('target rejection retains only fixed check identifiers, never raw focus details', async () => {
  for (const check of ['accessible-focus', 'PRIVATE_FIELD_OR_TITLE']) {
    const f = fixture();
    try {
      const pending = f.driver.request('paste');
      await nextTurn();
      f.reply({ id: 1, ok: false, code: 'target-changed', check });
      await assert.rejects(pending, (error) => {
        assert.equal(error.check, check === 'accessible-focus' ? check : undefined);
        assert.doesNotMatch(error.message, /PRIVATE/);
        return true;
      });
    } finally { f.driver.close(); }
  }
});

test('native timeout rejects pending work without leaking request text', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const pending = f.driver.request('paste', { text: 'PRIVATE_SYNTHETIC_TEXT' });
  await nextTurn();
  t.mock.timers.tick(8000);
  await assert.rejects(pending, (error) => {
    assert.match(error.message, /timed out/);
    assert.doesNotMatch(error.message, /PRIVATE/);
    return true;
  });
  assert.equal(f.child.killed, true);
});
