class RecordingCues {
  constructor(Context = globalThis.AudioContext) {
    this.Context = Context;
    this.pending = Promise.resolve();
  }
  async play(kind) {
    const melodies = { start: [660, 880], stop: [880, 660], cancel: [440, 330], error: [220, 220, 165] };
    if (!Object.hasOwn(melodies, kind)) throw new Error(`Unknown recording cue: ${kind}`);
    const playback = this.pending.then(() => this.playNotes(melodies[kind]));
    // Keep the queue usable after failure; the caller still receives the rejected playback.
    this.pending = playback.then(() => undefined, () => undefined);
    return playback;
  }
  async deadline(action, stage, milliseconds = 1500) {
    let timer;
    try {
      return await Promise.race([action(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Sound output ${stage} timed out.`)), milliseconds);
      })]);
    } finally {
      clearTimeout(timer);
    }
  }
  async playNotes(notes) {
    if (typeof this.Context !== 'function') throw new Error('Sound output unavailable: WebAudio is not supported.');
    // A fresh default-output context avoids retaining a stale device route between recordings.
    const context = new this.Context({ latencyHint: 'interactive' });
    const nodes = [], errors = [];
    const devices = globalThis.navigator?.mediaDevices;
    let stateChanged, deviceChanged;
    try {
      if (context.state === 'closed') throw new Error('Sound output context is closed.');
      await this.deadline(() => context.resume(), 'resume');
      if (context.state !== 'running') throw new Error(`Sound output is ${context.state}.`);
      let finish, fail;
      const ended = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      stateChanged = () => {
        if (context.state !== 'running') fail(new Error(`Sound output became ${context.state} during playback.`));
      };
      deviceChanged = () => fail(new Error('Sound output device changed during playback.'));
      context.addEventListener('statechange', stateChanged);
      devices?.addEventListener('devicechange', deviceChanged);
      const start = context.currentTime + 0.02;
      for (let index = 0; index < notes.length; index++) {
        const node = { tone: context.createOscillator(), ended: false, started: false };
        nodes.push(node);
        const { tone } = node;
        const gain = node.gain = context.createGain();
        const at = start + index * 0.09;
        tone.type = 'sine';
        tone.frequency.value = notes[index];
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(0.09, at + 0.008);
        gain.gain.linearRampToValueAtTime(0, at + 0.075);
        tone.connect(gain).connect(context.destination);
        tone.onended = () => {
          node.ended = true;
          if (context.currentTime + 128 / context.sampleRate < at + 0.08) {
            fail(new Error('Sound output ended before the cue completed.'));
          } else if (nodes.every((entry) => entry.ended)) finish();
        };
        tone.start(at);
        node.started = true;
        tone.stop(at + 0.08);
      }
      await this.deadline(() => ended, 'playback');
      if (context.state !== 'running') throw new Error(`Sound output is ${context.state}.`);
    } catch (error) {
      errors.push(error);
    } finally {
      if (stateChanged) context.removeEventListener('statechange', stateChanged);
      if (deviceChanged) devices?.removeEventListener('devicechange', deviceChanged);
      for (const { tone, gain, started, ended } of nodes) {
        tone.onended = null;
        if (started && !ended && context.state !== 'closed') {
          try { tone.stop(); } catch (error) { errors.push(error); }
        }
        try { tone.disconnect(); } catch (error) { errors.push(error); }
        if (gain) {
          try { gain.disconnect(); } catch (error) { errors.push(error); }
        }
      }
      if (context.state !== 'closed') {
        try { await this.deadline(() => context.close(), 'close', 1000); }
        catch (error) { errors.push(error); }
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Sound output playback or cleanup failed.');
  }
}

class VoiceWaveform {
  constructor(canvas) {
    this.canvas = canvas;
    this.values = Array(24).fill(0);
    this.draw(0);
  }
  draw(level) {
    this.values.shift();
    this.values.push(Math.min(1, Math.sqrt(Math.max(0, level)) * 2.4));
    const { width, height } = this.canvas;
    const context = this.canvas.getContext('2d');
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#67e8f9';
    const step = width / this.values.length;
    this.values.forEach((value, index) => {
      const bar = Math.max(2, value * (height - 4));
      context.fillRect(index * step, (height - bar) / 2, Math.max(1, step - 2), bar);
    });
  }
  reset() { this.values.fill(0); this.draw(0); }
}

if (typeof module !== 'undefined') module.exports = { RecordingCues, VoiceWaveform };
