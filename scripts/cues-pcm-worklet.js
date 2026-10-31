class CuePcmProbe extends AudioWorkletProcessor {
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (samples) {
      const copy = samples.slice();
      this.port.postMessage({ frame: currentFrame, samples: copy }, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor('cue-pcm-probe', CuePcmProbe);
