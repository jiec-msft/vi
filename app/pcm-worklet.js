class Pcm16Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(1600);
    this.used = 0;
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data === 'stop' && !this.stopped) {
        this.stopped = true;
        this.flush();
        this.port.postMessage({ type: 'ended' });
      }
    };
  }

  flush() {
    if (!this.used) return;
    const buffer = new ArrayBuffer(this.used * 2);
    const view = new DataView(buffer);
    let squares = 0;
    for (let i = 0; i < this.used; i++) {
      view.setInt16(i * 2, this.samples[i], true);
      squares += (this.samples[i] / 32768) ** 2;
    }
    const level = Math.min(1, Math.sqrt(squares / this.used));
    this.port.postMessage({ type: 'pcm', buffer, level }, [buffer]);
    this.used = 0;
  }

  process(inputs) {
    if (this.stopped) return false;
    const channel = inputs[0]?.[0];
    if (channel) {
      for (const value of channel) {
        const sample = Math.max(-1, Math.min(1, value));
        this.samples[this.used++] = Math.round(sample * (sample < 0 ? 32768 : 32767));
        if (this.used === this.samples.length) this.flush();
      }
    }
    return true;
  }
}
registerProcessor('pcm16-capture', Pcm16Capture);
