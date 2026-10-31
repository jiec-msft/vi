const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { PluginRuntime } = require('../../app/plugins/pipeline.cjs');
const { TranscriptOutput } = require('../../app/transcript-output.cjs');
const { descriptor, fakeFork } = require('./support/plugin-process.cjs');

function fixture(t, descriptions, plugins) {
  const fake = fakeFork(plugins);
  const runtime = new PluginRuntime(descriptions, fake.fork);
  t.after(() => runtime.close());
  const controller = new AbortController();
  return { ...fake, runtime, controller, pipeline: runtime.begin('run', 'developer', controller.signal) };
}
test('transforms follow order, guards always run last and outputs are sealed', async (t) => {
  const a = descriptor('test.first', ['output.guard', 'final.transform']), b = descriptor('test.second');
  const f = fixture(t, [a, b], {
    'test.first': { hooks: { 'final.transform': ({ inputText }) => ({ outcome: 'replace', text: `${inputText}A` }),
      'output.guard': ({ inputText }) => ({ outcome: inputText === 'xAB' ? 'allow' : 'block' }) } },
    'test.second': { hooks: { 'final.transform': ({ inputText }) => ({ outcome: 'replace', text: `${inputText}B` }) } },
  });
  const sealed = await f.pipeline.final('x');
  assert.equal(sealed.text, 'xAB');
  assert.ok(Object.isFrozen(sealed));
  assert.deepEqual(f.calls.filter((call) => call.type === 'call').map((call) => call.hook),
    ['final.transform', 'final.transform', 'output.guard']);
  const output = new TranscriptOutput(f.pipeline);
  output.accept('x', sealed);
  assert.equal(output.copy(), 'xAB');
  assert.throws(() => output.original(), /unavailable/);
});
test('valid empty output is suppressed, guard checks it, original access remains forbidden', async (t) => {
  const f = fixture(t, [descriptor('test.filter', ['final.transform', 'output.guard'], true)], {
    'test.filter': { hooks: { 'final.transform': () => ({ outcome: 'replace', text: '' }),
      'output.guard': ({ inputText }) => ({ outcome: inputText === '' ? 'allow' : 'block' }) } },
  });
  const result = await f.pipeline.final('secret');
  assert.equal(result.outcome, 'suppressed');
  const output = new TranscriptOutput(f.pipeline);
  output.accept('secret', result);
  assert.throws(() => output.copy());
  assert.throws(() => output.original());
});
test('explicit suppress stops later transforms but still invokes guards', async (t) => {
  const f = fixture(t, [descriptor('test.suppress'), descriptor('test.after', ['final.transform', 'output.guard'])], {
    'test.suppress': { hooks: { 'final.transform': () => ({ outcome: 'suppress' }) } },
    'test.after': { hooks: { 'final.transform': () => { throw new Error('must not run'); },
      'output.guard': () => ({ outcome: 'allow' }) } },
  });
  assert.equal((await f.pipeline.final('x')).outcome, 'suppressed');
});
test('privacy suppresses preview callbacks and guard block never yields an output', async (t) => {
  const f = fixture(t, [descriptor('test.guard', ['preview.transform', 'output.guard'])], {
    'test.guard': { hooks: { 'preview.transform': () => { throw new Error('must not run'); },
      'output.guard': () => ({ outcome: 'block' }) } },
  });
  f.pipeline.preview('secret', () => assert.fail('preview leaked'), () => assert.fail('preview ran'));
  await assert.rejects(f.pipeline.final('secret'), /blocked/);
});
test('preview coalesces latest revisions; final waits for in-flight preview', async (t) => {
  let release;
  const f = fixture(t, [descriptor('test.preview', ['preview.transform', 'final.transform'])], {
    'test.preview': { hooks: { 'preview.transform': ({ inputText }) => inputText === 'one'
      ? new Promise((resolve) => { release = resolve; }) : { outcome: 'replace', text: inputText.toUpperCase() },
    'final.transform': ({ inputText }) => ({ outcome: 'replace', text: `${inputText}!` }) } },
  });
  await f.runtime.warmup();
  const shown = [];
  for (const value of ['one', 'two', 'three']) f.pipeline.preview(value, (text) => shown.push(text), assert.fail);
  await nextTurn();
  release({ outcome: 'replace', text: 'ONE' });
  await nextTurn();
  assert.deepEqual(shown, ['THREE']);
  assert.equal((await f.pipeline.final('final')).text, 'final!');
});
test('preview failure warns, skips the faulty plugin and preserves final dictation', async (t) => {
  const f = fixture(t, [descriptor('test.preview', ['preview.transform', 'final.transform'])], {
    'test.preview': { hooks: { 'preview.transform': () => { throw new Error('bad'); }, 'final.transform': () => ({ outcome: 'keep' }) } },
  });
  const warnings = [], previews = [];
  f.runtime.onWarning = (warning) => warnings.push(warning);
  f.pipeline.preview('raw', (text) => previews.push(text), assert.fail);
  await nextTurn();
  assert.deepEqual(previews, ['raw']);
  assert.equal((await f.pipeline.final('raw')).text, 'raw');
  assert.equal(warnings[0].pluginId, 'test.preview');
  assert.equal(warnings[0].code, 'plugin-error');
  assert.equal(f.calls.filter((call) => call.hook === 'final.transform').length, 0);
});

test('one plugin init failure does not close or skip healthy plugins', async (t) => {
  const f = fixture(t, [descriptor('test.bad'), descriptor('test.good')], {
    'test.bad': { validateConfig() { throw new Error('private configuration'); }, hooks: {} },
    'test.good': { hooks: { 'final.transform': ({ inputText }) => ({ outcome: 'replace', text: `${inputText}!` }) } },
  });
  const warnings = [];
  f.runtime.onWarning = (warning) => warnings.push(warning);
  await f.runtime.warmup();
  assert.equal((await f.pipeline.final('original')).text, 'original!');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].stage, 'init');
  assert.ok(!JSON.stringify(warnings).includes('private configuration'));
});

for (const hook of ['final.transform', 'output.guard']) {
  test(`${hook} exception keeps its input, warns and still runs healthy downstream hooks`, async (t) => {
    const f = fixture(t, [descriptor('test.first'), descriptor('test.bad', [hook]),
      descriptor('test.after', ['final.transform', 'output.guard'])], {
      'test.first': { hooks: { 'final.transform': ({ inputText }) => ({ outcome: 'replace', text: `${inputText}A` }) } },
      'test.bad': { hooks: { [hook]: () => { throw new Error('private transcript'); } } },
      'test.after': { hooks: { 'final.transform': ({ inputText }) => ({ outcome: 'replace', text: `${inputText}B` }),
        'output.guard': () => ({ outcome: 'allow' }) } },
    });
    const warnings = [];
    f.runtime.onWarning = (warning) => warnings.push(warning);
    assert.equal((await f.pipeline.final('x')).text, 'xAB');
    assert.equal(warnings[0].stage, hook);
    assert.ok(!JSON.stringify(warnings).includes('private transcript'));
  });
}

for (const fault of ['exit', 'invalid-reply', 'process-error']) for (const entry of ['warmup', 'call']) {
  test(`idle ${fault} is warned and quarantined before ${entry}, not silently restarted`, async (t) => {
    const f = fixture(t, [descriptor()], { 'test.algorithm': { hooks: {
      'final.transform': ({ inputText }) => ({ outcome: 'replace', text: `${inputText}!` }),
    } } });
    const warnings = [];
    f.runtime.onWarning = (warning) => warnings.push(warning);
    await f.runtime.warmup();
    if (fault === 'exit') f.children[0].emit('exit', 9);
    else if (fault === 'invalid-reply') f.children[0].emit('message', { identity: 'old', requestId: 'old' });
    else f.children[0].emit('error', new Error('private child details'));
    await nextTurn();
    if (entry === 'warmup') await f.runtime.warmup();
    assert.equal((await f.pipeline.final('input')).text, 'input');
    assert.equal((await f.runtime.begin('next', 'developer').final('input')).text, 'input');
    assert.equal(f.children.length, 1);
    assert.equal(f.runtime.failures.size, 1);
    assert.equal(warnings[0].code, fault === 'exit' ? 'process-exit' : fault === 'process-error' ? 'process-error' : 'invalid-reply');
    assert.ok(!JSON.stringify(warnings).includes('private child details'));
  });
}

test('intentional cancellation closes healthy children but allows warmup for a new recording', async (t) => {
  const f = fixture(t, [descriptor()], { 'test.algorithm': { hooks: {
    'final.transform': ({ inputText }) => ({ outcome: 'replace', text: `${inputText}!` }),
  } } });
  await f.runtime.warmup();
  f.controller.abort();
  await f.pipeline.cancelled;
  await f.runtime.warmup();
  assert.equal((await f.runtime.begin('next', 'developer').final('input')).text, 'input!');
  assert.equal(f.children.length, 2);
  assert.equal(f.runtime.failures.size, 0);
});
