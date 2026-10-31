const observedContexts = [];
let outputFault;
const nativeContext = globalThis.AudioContext;
class ObservedCueContext extends nativeContext {
  constructor(options) {
    probeAssert(observedContexts.every((context) => context.state === 'closed'), 'Cue contexts overlapped.');
    super(options);
    this.frames = [];
    this.tones = [];
    this.gains = [];
    this.closeCalls = 0;
    this.fault = outputFault;
    observedContexts.push(this);
  }
  async resume() {
    if (this.fault === 'resume') throw new Error('Injected output resume failure.');
    await this.audioWorklet.addModule('cues-pcm-worklet.js');
    this.tap = new AudioWorkletNode(this, 'cue-pcm-probe');
    this.silence = super.createGain();
    this.silence.gain.value = 0;
    this.tap.connect(this.silence).connect(this.destination);
    this.tap.port.onmessage = ({ data }) => {
      this.frames.push(data);
      const canvas = document.getElementById('waveform'), drawing = canvas.getContext('2d');
      drawing.clearRect(0, 0, canvas.width, canvas.height);
      drawing.strokeStyle = '#67e8f9';
      drawing.beginPath();
      data.samples.forEach((sample, index) => {
        const x = index * canvas.width / data.samples.length;
        const y = canvas.height / 2 - sample * canvas.height * 4;
        if (index) drawing.lineTo(x, y); else drawing.moveTo(x, y);
      });
      drawing.stroke();
    };
    return super.resume();
  }
  createGain() {
    const gain = super.createGain(), connect = gain.connect.bind(gain), disconnect = gain.disconnect.bind(gain);
    gain.disconnectCalls = 0;
    gain.connect = (destination, ...ports) => {
      const result = connect(destination, ...ports);
      // Observe the real destination-bound signal without replacing or muting its output route.
      if (destination === this.destination) connect(this.tap);
      return result;
    };
    gain.disconnect = (...ports) => { gain.disconnectCalls++; return disconnect(...ports); };
    this.gains.push(gain);
    return gain;
  }
  createOscillator() {
    const tone = super.createOscillator(), start = tone.start.bind(tone), stop = tone.stop.bind(tone);
    const disconnect = tone.disconnect.bind(tone);
    tone.disconnectCalls = 0;
    tone.start = (at) => { tone.scheduledStart = at; return start(at); };
    tone.stop = (at) => {
      if (at !== undefined) {
        tone.scheduledStop = at;
        if (this.tones.length === 1 && ['suspend', 'closed', 'devicechange'].includes(this.fault)) {
          this.faultTimer = setTimeout(() => {
            const change = this.fault === 'suspend' ? this.suspend()
              : this.fault === 'closed' ? this.close()
                : Promise.resolve(navigator.mediaDevices.dispatchEvent(new Event('devicechange')));
            change.catch((error) => { this.faultError = error.message; });
          }, 40);
        }
      }
      return stop(at);
    };
    tone.disconnect = (...ports) => { tone.disconnectCalls++; return disconnect(...ports); };
    this.tones.push(tone);
    return tone;
  }
  async close() {
    this.closeCalls++;
    clearTimeout(this.faultTimer);
    // Drain posted PCM blocks before closing the observation port.
    try { await new Promise((resolve) => setTimeout(resolve, 30)); return await super.close(); }
    finally {
      this.tap?.disconnect();
      this.silence?.disconnect();
      this.tap?.port.close();
    }
  }
}
globalThis.AudioContext = ObservedCueContext;
window.cueProbeDiagnostics = () => observedContexts.map((context) => {
  const { samples } = pcm(context);
  return { state: context.state, fault: context.fault, faultError: context.faultError,
    sampleRate: context.sampleRate, frames: context.frames.length, closeCalls: context.closeCalls,
    peak: samples.reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0),
    tones: context.tones.map((tone) => ({ frequency: tone.frequency.value, start: tone.scheduledStart,
      stop: tone.scheduledStop, disconnectCalls: tone.disconnectCalls })),
    gainsDisconnected: context.gains.map((gain) => gain.disconnectCalls) };
});

function probeAssert(condition, message) {
  if (!condition) throw new Error(message);
}
function pcm(context) {
  const first = context.frames[0]?.frame || 0;
  const end = Math.max(first, ...context.frames.map((block) => block.frame + block.samples.length));
  const samples = new Float32Array(end - first);
  context.frames.forEach((block) => samples.set(block.samples, block.frame - first));
  return { first, samples };
}
function magnitude(samples, frequency, sampleRate) {
  let real = 0, imaginary = 0;
  samples.forEach((sample, index) => {
    const phase = 2 * Math.PI * frequency * index / sampleRate;
    real += sample * Math.cos(phase);
    imaginary += sample * Math.sin(phase);
  });
  return 2 * Math.hypot(real, imaginary) / samples.length;
}
function verifyPcm(context, expected) {
  probeAssert(context.state === 'closed' && context.closeCalls === 1, 'Output context was not closed exactly once.');
  probeAssert(context.tones.every((tone) => tone.disconnectCalls === 1), 'Oscillator resources were not released.');
  probeAssert(context.gains.every((gain) => gain.disconnectCalls === 1), 'Gain resources were not released.');
  const { first, samples } = pcm(context);
  const peak = samples.reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0);
  probeAssert(peak > 0.02 && peak <= 0.091, `PCM peak outside cue bounds: ${peak}`);
  probeAssert(context.tones.length === expected.length, 'Wrong number of cue notes.');
  const notes = context.tones.map((tone, index) => {
    const at = tone.scheduledStart;
    probeAssert(tone.frequency.value === expected[index], 'Cue frequency metadata mismatch.');
    probeAssert(Math.abs(tone.scheduledStop - at - 0.08) < 1e-9, 'Cue tone duration changed.');
    probeAssert(tone.scheduledStop - context.tones[0].scheduledStart <= 0.261, 'Cue duration exceeded its bound.');
    const from = Math.round((at + 0.015) * context.sampleRate) - first;
    const to = Math.round((at + 0.065) * context.sampleRate) - first;
    probeAssert(from >= 0 && to <= samples.length, 'PCM did not cover the scheduled note.');
    const window = samples.slice(from, to);
    const strength = magnitude(window, expected[index], context.sampleRate);
    const other = Math.max(...[165, 220, 330, 440, 660, 880].filter((value) => value !== expected[index])
      .map((value) => magnitude(window, value, context.sampleRate)));
    probeAssert(strength > 0.015 && strength > other * 1.5, 'PCM does not contain the expected dominant sine frequency.');
    const quiet = samples.slice(Math.round((at + 0.077) * context.sampleRate) - first,
      Math.round((at + 0.08) * context.sampleRate) - first);
    probeAssert(quiet.length > 0 && quiet.every((sample) => Math.abs(sample) < 0.001), 'Cue envelope did not fade to silence.');
    return { frequency: expected[index], strength, other, start: at, stop: tone.scheduledStop };
  });
  return { sampleRate: context.sampleRate, sampleCount: samples.length, peak, notes, closeCalls: context.closeCalls };
}
window.runCueProbe = async () => {
  const checks = [], recordings = [];
  const melodies = { start: [660, 880], stop: [880, 660], cancel: [440, 330], error: [220, 220, 165] };
  await window.setCueSounds(false);
  await window.playRendererCue('start');
  probeAssert(observedContexts.length === 0, 'Disabled sounds created an output context.');
  checks.push('renderer-sounds-disabled');
  await window.setCueSounds(true);
  for (let round = 0; round < 3; round++) {
    for (const [kind, notes] of Object.entries(melodies)) {
      document.getElementById('current').textContent = `Round ${round + 1}: ${kind}`;
      const before = observedContexts.length;
      await window.playRendererCue(kind);
      probeAssert(observedContexts.length === before + 1, 'Cue reused a previous context.');
      const context = observedContexts.at(-1);
      const summary = verifyPcm(context, notes);
      recordings.push({ kind, round, ...summary, samples: Array.from(pcm(context).samples) });
      document.getElementById('results').textContent += `${kind}: PCM OK, peak ${summary.peak.toFixed(3)}, context closed\n`;
    }
  }
  checks.push('actual-destination-graph-and-pcm', 'all-four-cue-melodies', 'bounded-volume-and-envelope',
    'repeated-fresh-contexts', 'owned-audio-resources-closed');
  for (const fault of ['resume', 'suspend', 'closed', 'devicechange']) {
    outputFault = fault;
    document.getElementById('preferences-result').textContent = '';
    await window.playRendererCue('start');
    const failed = observedContexts.at(-1);
    probeAssert(document.getElementById('preferences-result').textContent.includes('Sound output unavailable'),
      `${fault} failure was not visible in the renderer.`);
    probeAssert(failed.state === 'closed' && failed.closeCalls === 1, `${fault} failure leaked its context.`);
    probeAssert(failed.tones.every((tone) => tone.disconnectCalls === 1), `${fault} failure leaked oscillators.`);
    probeAssert(!failed.faultError, failed.faultError);
    outputFault = undefined;
    await window.playRendererCue('cancel');
    verifyPcm(observedContexts.at(-1), melodies.cancel);
    checks.push(`${fault}-failure-visible-and-next-cue-recovers`);
  }
  const before = observedContexts.length;
  await Promise.all(['start', 'stop', 'cancel'].map((kind) => window.playRendererCue(kind)));
  observedContexts.slice(before).forEach((context, index) =>
    verifyPcm(context, melodies[['start', 'stop', 'cancel'][index]]));
  checks.push('rapid-start-stop-cancel-order');
  probeAssert(observedContexts.every((context) => context.state === 'closed'), 'A context remained open.');
  document.getElementById('current').textContent = 'PASS: actual PCM and lifecycle checks complete';
  return { checks, recordings, contextCount: observedContexts.length,
    outputScope: 'actual-WebAudio-default-destination-with-PCM-observation-tap',
    deviceScope: 'fresh-default-route-and-synthetic-devicechange-event-not-hardware-routing',
    physicalSpeakerAudibility: 'not-verified-manual-listening-required' };
};
