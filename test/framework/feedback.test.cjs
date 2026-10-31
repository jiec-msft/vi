const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { RecordingCues, VoiceWaveform } = require('../../app/audio-feedback.js');

function contexts(behavior = () => ({})) {
  const instances = [];
  class Context extends EventTarget {
    currentTime = 0;
    sampleRate = 48000;
    state = 'suspended';
    destination = {};
    tones = [];
    gains = [];
    closed = 0;
    constructor() {
      super();
      this.behavior = behavior(instances.length);
      this.state = this.behavior.initialState || 'suspended';
      instances.push(this);
    }
    async resume() {
      if (this.behavior.resumeError) throw new Error('resume failed');
      if (this.behavior.resumePending) return new Promise(() => {});
      this.changeState(this.behavior.resumeState || 'running');
    }
    changeState(state) { this.state = state; this.dispatchEvent(new Event('statechange')); }
    async close() {
      this.closed++;
      if (this.behavior.closeError) throw new Error('close failed');
      if (this.behavior.closePending) return new Promise(() => {});
      this.changeState('closed');
    }
    createOscillator() {
      if (this.behavior.graphError && this.tones.length === 1) throw new Error('graph failed');
      const tone = { type: '', frequency: { value: 0 }, connect: (gain) => gain,
        start: (at) => { tone.at = at; }, disconnected: 0,
        stop: (at) => {
          if (at === undefined) { clearTimeout(tone.timer); return; }
          tone.until = at;
          if (this.behavior.interrupt) {
            queueMicrotask(() => this.changeState(this.behavior.interrupt));
          } else if (!this.behavior.endedPending) {
            tone.timer = setTimeout(() => {
              this.currentTime = this.behavior.earlyEnd ? 0 : at;
              tone.onended?.();
            }, 5 + this.tones.indexOf(tone));
          }
        },
        disconnect: () => { tone.disconnected++; } };
      this.tones.push(tone);
      return tone;
    }
    createGain() {
      const levels = [];
      const gain = { gain: { setValueAtTime: (level, at) => levels.push([level, at]),
        linearRampToValueAtTime: (level, at) => levels.push([level, at]) },
        levels, connect() {}, disconnected: 0,
        disconnect: () => { gain.disconnected++; } };
      this.gains.push(gain);
      return gain;
    }
  }
  return { Context, instances };
}

function released(context) {
  assert.equal(context.closed, 1);
  assert.equal(context.state, 'closed');
  assert.ok(context.tones.every((tone) => tone.disconnected === 1));
  assert.ok(context.gains.every((gain) => gain.disconnected === 1));
}

test('all cue melodies preserve distinct order, volume, envelopes and duration bounds', async () => {
  const { Context, instances } = contexts();
  const cues = new RecordingCues(Context);
  await Promise.all(['start', 'stop', 'cancel', 'error'].map((kind) => cues.play(kind)));
  assert.deepEqual(instances.map((context) => context.tones.map((tone) => tone.frequency.value)),
    [[660, 880], [880, 660], [440, 330], [220, 220, 165]]);
  for (const context of instances) {
    released(context);
    context.tones.forEach((tone, index) => {
      assert.equal(tone.type, 'sine');
      assert.ok(Math.abs(tone.at - context.tones[0].at - index * 0.09) < 1e-9);
      assert.ok(Math.abs(tone.until - tone.at - 0.08) < 1e-9);
      assert.ok(tone.until <= 0.31);
      assert.deepEqual(context.gains[index].levels, [[0, tone.at], [0.09, tone.at + 0.008], [0, tone.at + 0.075]]);
    });
  }
});

test('rapid start, stop and cancel requests never overlap owned output contexts', async () => {
  const { Context, instances } = contexts((index) => {
    if (index) assert.equal(instances[index - 1].state, 'closed');
    return {};
  });
  const cues = new RecordingCues(Context);
  for (let round = 0; round < 12; round++) {
    await Promise.all(['start', 'stop', 'cancel'].map((kind) => cues.play(kind)));
  }
  assert.equal(instances.length, 36);
  instances.forEach(released);
});

test('a closed or suspended previous device context is never reused', async () => {
  const { Context, instances } = contexts();
  const cues = new RecordingCues(Context);
  await cues.play('start');
  instances[0].changeState('suspended');
  await cues.play('stop');
  instances[1].changeState('closed');
  await cues.play('cancel');
  assert.equal(instances.length, 3);
  assert.equal(instances[2].state, 'closed');
});

for (const interrupt of ['suspended', 'interrupted', 'closed']) {
  test(`${interrupt} output during playback rejects and the next cue gets a fresh context`, async () => {
    const { Context, instances } = contexts((index) => index ? {} : { interrupt });
    const cues = new RecordingCues(Context);
    await assert.rejects(cues.play('start'), /Sound output/);
    await cues.play('cancel');
    assert.equal(instances.length, 2);
    assert.ok(instances[0].tones.every((tone) => tone.disconnected === 1));
    released(instances[1]);
  });
}

for (const behavior of [{ resumeError: true }, { resumeState: 'suspended' }, { initialState: 'closed' },
  { graphError: true }, { earlyEnd: true }]) {
  test(`output failure propagates and releases partial resources: ${JSON.stringify(behavior)}`, async () => {
    const { Context, instances } = contexts(() => behavior);
    await assert.rejects(new RecordingCues(Context).play('error'), /Sound output|resume failed|graph failed/);
    assert.ok(instances[0].tones.every((tone) => tone.disconnected === 1));
    assert.ok(instances[0].gains.every((gain) => gain.disconnected === 1));
    assert.equal(instances[0].state, 'closed');
  });
}

for (const flag of ['resumePending', 'endedPending', 'closePending']) {
  test(`${flag} has a bounded deadline and does not block the next cue`, async () => {
    const { Context, instances } = contexts((index) => index ? {} : { [flag]: true });
    const cues = new RecordingCues(Context);
    const started = Date.now();
    const failed = assert.rejects(cues.play('start'), /Sound output.*timed out/);
    const next = cues.play('stop');
    await failed;
    await next;
    assert.ok(Date.now() - started < 4000);
    assert.equal(instances[0].closed, 1);
    released(instances[1]);
  });
}

test('close failure is reported, including when playback also fails', async () => {
  for (const resumeError of [false, true]) {
    const { Context, instances } = contexts(() => ({ closeError: true, resumeError }));
    await assert.rejects(new RecordingCues(Context).play('start'), (error) => {
      if (resumeError) {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors.map((entry) => entry.message), ['resume failed', 'close failed']);
      } else assert.equal(error.message, 'close failed');
      return true;
    });
    assert.equal(instances[0].closed, 1);
    assert.ok(instances[0].tones.every((tone) => tone.disconnected === 1));
  }
});

test('unknown cues and unavailable WebAudio reject rather than silently succeed', async () => {
  const { Context, instances } = contexts();
  for (const kind of ['missing', 'toString', '__proto__']) {
    await assert.rejects(new RecordingCues(Context).play(kind), /Unknown recording cue/);
  }
  assert.equal(instances.length, 0);
  await assert.rejects(new RecordingCues(null).play('start'), /Sound output/);
});

test('renderer sounds gate suppresses output and visibly reports playback failure', async () => {
  const source = fs.readFileSync(require.resolve('../../app/renderer.js'), 'utf8');
  const prefix = source.slice(0, source.indexOf('\nfunction showStatus('));
  assert.ok(prefix.includes('function cue(kind)'));
  const { Context, instances } = contexts((index) => index ? { resumeError: true } : {});
  const result = { textContent: '', classList: { add(value) { result.error = value; } } };
  const scope = vm.createContext({ RecordingCues: class extends RecordingCues {
    constructor() { super(Context); }
  }, VoiceWaveform: class {}, document: { getElementById: () => result } });
  vm.runInContext(prefix, scope);
  await vm.runInContext("soundsEnabled = false; cue('start')", scope);
  assert.equal(instances.length, 0);
  await vm.runInContext("soundsEnabled = true; cue('start')", scope);
  released(instances[0]);
  await vm.runInContext("cue('stop')", scope);
  assert.match(result.textContent, /Sound output unavailable/);
  assert.equal(result.error, 'error');
});

test('waveform changes with microphone level and resets to a quiet baseline', () => {
  const rectangles = [];
  const canvas = { width: 104, height: 20,
    getContext: () => ({ clearRect() {}, fillRect: (...args) => rectangles.push(args) }) };
  const waveform = new VoiceWaveform(canvas);
  assert.equal(Math.max(...rectangles.map((entry) => entry[3])), 2);
  waveform.draw(0.5);
  assert.ok(rectangles.at(-1)[3] > 2);
  waveform.reset();
  assert.deepEqual(waveform.values, Array(24).fill(0));
});
