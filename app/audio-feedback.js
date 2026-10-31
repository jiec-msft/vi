class RecordingCues {
  constructor(Context = globalThis.AudioContext) { this.Context = Context; }
  async play(kind) {
    const notes = { start: [660, 880], stop: [880, 660], cancel: [440, 330], error: [220, 220, 165] }[kind];
    if (!notes) return;
    this.context ??= new this.Context();
    await this.context.resume();
    const start = this.context.currentTime;
    for (let index = 0; index < notes.length; index++) {
      const tone = this.context.createOscillator();
      const gain = this.context.createGain();
      const at = start + index * 0.09;
      tone.type = 'sine';
      tone.frequency.value = notes[index];
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.09, at + 0.008);
      gain.gain.linearRampToValueAtTime(0, at + 0.075);
      tone.connect(gain).connect(this.context.destination);
      tone.start(at);
      tone.stop(at + 0.08);
      tone.onended = () => { tone.disconnect(); gain.disconnect(); };
    }
    await new Promise((resolve) => setTimeout(resolve, notes.length * 90 + 40));
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
