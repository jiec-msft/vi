const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RecordingCues, VoiceWaveform } = require('../../app/audio-feedback.js');

test('start and stop cues are distinct bounded-volume ascending/descending notes', async () => {
  const notes = [];
  class Context {
    currentTime = 0;
    destination = {};
    async resume() {}
    createOscillator() {
      const tone = { type: '', frequency: { value: 0 }, connect: (gain) => gain,
        start: (at) => notes.push({ frequency: tone.frequency.value, at }),
        stop() {}, disconnect() {} };
      return tone;
    }
    createGain() {
      return { gain: { setValueAtTime() {}, linearRampToValueAtTime: (level) => assert.ok(level <= 0.1) },
        connect() {}, disconnect() {} };
    }
  }
  const cues = new RecordingCues(Context);
  await cues.play('start');
  await cues.play('stop');
  assert.deepEqual(notes.map((note) => note.frequency), [660, 880, 880, 660]);
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
