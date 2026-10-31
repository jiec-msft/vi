const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { AudioTurn } = require('../../app/audio-turn.cjs');

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(options = {}) {
  const connection = deferred(), sent = [], failures = [], events = [];
  const session = {
    start: () => connection.promise,
    audio: async (bytes) => sent.push(Buffer.from(bytes)),
    finish: async () => { events.push('finish'); return 'transcript'; },
    cancel() { events.push('cancel'); },
    stopRecordingDeadline() { events.push('stop-deadline'); },
    close() { events.push('close'); },
  };
  const turn = new AudioTurn({ onFailure: (error) => failures.push(error.message), ...options });
  return { turn, session, connection, sent, failures, events };
}

test('speech is buffered immediately, and Stop before connection still sends every sample once before final', async () => {
  const f = fixture();
  f.turn.push(Buffer.from([1, 0, 2, 0]));
  f.turn.push(Buffer.from([3, 0]));
  f.turn.connect(f.session);
  let done = false;
  const final = f.turn.finish().then((text) => { done = true; return text; });
  await nextTurn();
  assert.equal(done, false);
  assert.equal(f.sent.length, 0);
  assert.equal(f.turn.queuedBytes, 6);
  f.connection.resolve();
  assert.equal(await final, 'transcript');
  assert.deepEqual(Buffer.concat(f.sent), Buffer.from([1, 0, 2, 0, 3, 0]));
  assert.equal(f.turn.queuedBytes, 0);
  assert.equal(f.events.at(-1), 'finish');
});

test('buffer drain is serialized against live audio and completes before ptt_end', async () => {
  const f = fixture();
  const firstWrite = deferred();
  let inFlight = 0, peak = 0;
  f.session.audio = async (data) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    f.sent.push(Buffer.from(data));
    if (f.sent.length === 1) await firstWrite.promise;
    inFlight--;
  };
  f.turn.push(Buffer.from([1, 0]));
  f.turn.connect(f.session);
  f.connection.resolve();
  await nextTurn();
  f.turn.push(Buffer.from([2, 0]));
  const final = f.turn.finish();
  await nextTurn();
  assert.equal(f.events.includes('finish'), false);
  firstWrite.resolve();
  assert.equal(await final, 'transcript');
  assert.equal(peak, 1);
  assert.deepEqual(Buffer.concat(f.sent), Buffer.from([1, 0, 2, 0]));
});

test('cancel before connection discards in-memory audio and prevents a late connection from sending it', async () => {
  const f = fixture();
  f.turn.push(Buffer.alloc(3200));
  f.turn.connect(f.session);
  const final = f.turn.finish();
  f.turn.cancel();
  await assert.rejects(final, /cancelled/);
  f.connection.resolve();
  await nextTurn();
  assert.equal(f.sent.length, 0);
  assert.equal(f.turn.queuedBytes, 0);
  assert.equal(f.turn.chunks.length, 0);
});

test('connection failure is reported once and cannot become successful empty transcription', async () => {
  const f = fixture();
  f.turn.push(Buffer.alloc(2));
  f.turn.connect(f.session);
  const final = f.turn.finish();
  f.connection.reject(new Error('connection timed out'));
  await assert.rejects(final, /connection timed out/);
  assert.deepEqual(f.failures, ['connection timed out']);
  assert.equal(f.turn.queuedBytes, 0);
  assert.equal(f.events.includes('finish'), false);
});

test('connection and target validation overlap, but blocked input validation cannot upload recorded speech', async () => {
  const f = fixture();
  const policy = deferred();
  f.turn.push(Buffer.alloc(3200));
  f.turn.connect(f.session, policy.promise);
  const final = f.turn.finish();
  f.connection.resolve();
  await nextTurn();
  assert.equal(f.sent.length, 0);
  policy.reject(new Error('Password field blocked'));
  await assert.rejects(final, /Password field blocked/);
  assert.equal(f.sent.length, 0);
  assert.equal(f.turn.queuedBytes, 0);
});

test('the pending-memory cap rejects overflow explicitly instead of truncating the recording or imposing a total-duration cap', async () => {
  const f = fixture({ maxBytes: 10 });
  f.turn.push(Buffer.alloc(6, 1));
  assert.throws(() => f.turn.push(Buffer.alloc(6, 2)), /Pending audio exceeded/);
  assert.equal(f.turn.bytes, 6);
  assert.equal(f.turn.queuedBytes, 0);
  assert.equal(f.failures.length, 1);
});

test('continuous audio is sent once across five exact segments, without a two-minute total cap', async () => {
  const segments = [];
  const f = fixture({ onSegment: async (text, index, bytes) => segments.push({ text, index, bytes }) });
  f.session.finishTurn = async () => `segment ${segments.length + 1}`;
  f.session.close = () => f.events.push('close');
  f.turn.connect(f.session);
  f.connection.resolve();
  await nextTurn();
  const voiced = Buffer.alloc(32000);
  for (let sample = 0; sample < voiced.length; sample += 2) voiced.writeInt16LE(5000, sample);
  for (let second = 0; second < 150; second++) {
    f.turn.push(voiced);
    await nextTurn();
  }
  assert.equal(f.turn.completedSegments, 5);
  assert.equal(f.turn.bytes, 150 * 32000);
  assert.equal(f.turn.failure, undefined);
  assert.ok(segments.every((segment) => segment.bytes === 30 * 32000));
  assert.equal(await f.turn.finish(), 'segment 1 segment 2 segment 3 segment 4 segment 5');
  assert.equal(Buffer.concat(f.sent).length, f.turn.bytes);
  assert.equal(f.turn.queuedBytes, 0);
  assert.equal(f.events.at(-1), 'close');
});

test('finalization buffers new audio, awaits segment text commit, and never starts the next turn early', async () => {
  const final = deferred(), commit = deferred(), order = [];
  const f = fixture({ segmentBytes: 8, onSegment: async () => { order.push('commit'); await commit.promise; } });
  f.session.finishTurn = async () => { order.push('ptt_end'); return final.promise; };
  f.turn.connect(f.session);
  f.connection.resolve();
  f.turn.push(Buffer.from([1,0,2,0,3,0,4,0]));
  await nextTurn();
  f.turn.push(Buffer.from([5,0,6,0]));
  await nextTurn();
  assert.equal(Buffer.concat(f.sent).length, 8);
  assert.equal(f.turn.queuedBytes, 4);
  final.resolve('first');
  await nextTurn();
  assert.deepEqual(order, ['ptt_end', 'commit']);
  assert.equal(Buffer.concat(f.sent).length, 8);
  commit.resolve();
  await nextTurn();
  assert.deepEqual(Buffer.concat(f.sent), Buffer.from([1,0,2,0,3,0,4,0,5,0,6,0]));
  assert.equal(await f.turn.finish(), 'first transcript');
  assert.equal(f.turn.tailText, ' transcript');
});

test('a late pause near thirty seconds is preferred to an arbitrary cut, and a short recording is not cut early', async () => {
  const segments = [];
  const f = fixture({ onSegment: async (_text, _index, bytes) => segments.push(bytes) });
  f.session.finishTurn = async () => 'quiet boundary';
  f.turn.connect(f.session); f.connection.resolve();
  const voiced = Buffer.alloc(32000);
  for (let sample = 0; sample < voiced.length; sample += 2) voiced.writeInt16LE(5000, sample);
  for (let second = 0; second < 25; second++) { f.turn.push(voiced); await nextTurn(); }
  assert.equal(segments.length, 0);
  f.turn.push(Buffer.alloc(9600));
  await nextTurn();
  assert.deepEqual(segments, [25 * 32000 + 9600]);
  assert.equal(await f.turn.finish(), 'quiet boundary');
});

test('an edit-boundary cut finalizes early and every later PCM sample enters the new turn exactly once', async () => {
  const f = fixture();
  const segments = [];
  f.turn.onSegment = async (text) => segments.push(text);
  f.session.finishTurn = async () => 'edited segment';
  f.turn.connect(f.session); f.connection.resolve();
  f.turn.push(Buffer.from([1,0,2,0]));
  await nextTurn();
  assert.equal(f.turn.cut(), true);
  f.turn.push(Buffer.from([3,0,4,0]));
  await nextTurn(); await nextTurn();
  assert.deepEqual(segments, ['edited segment']);
  assert.equal(await f.turn.finish(), 'edited segment transcript');
  assert.deepEqual(Buffer.concat(f.sent), Buffer.from([1,0,2,0,3,0,4,0]));
});

test('zero audio and invalid chunks fail explicitly', async () => {
  const f = fixture();
  await assert.rejects(f.turn.finish(), /No microphone audio/);
  assert.throws(() => f.turn.push(Buffer.alloc(2)), /stopped/);
  const other = fixture();
  for (const data of [Buffer.alloc(0), Buffer.alloc(1), Buffer.alloc(32002)]) {
    assert.throws(() => other.turn.push(data), /Invalid/);
  }
  other.turn.cancel();
});

test('Stop during connection has a finite 60-second completion deadline and releases its buffer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.turn.push(Buffer.alloc(3200));
  f.turn.connect(f.session);
  const final = f.turn.finish();
  t.mock.timers.tick(60000);
  await assert.rejects(final, /60 seconds/);
  assert.equal(f.turn.queuedBytes, 0);
  assert.equal(f.events.includes('cancel'), true);
  f.connection.resolve();
});
