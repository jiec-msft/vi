let capture;
window.__released = false;
window.__failure = undefined;
document.getElementById('toggle').onclick = async () => {
  try {
    if (capture) {
      const previous = capture;
      capture = undefined;
      previous.stream.getTracks().forEach((track) => track.stop());
      previous.node.disconnect();
      await previous.context.close();
      window.__released = previous.stream.getTracks().every((track) => track.readyState === 'ended');
      await window.vi.finish();
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000 }, video: false });
    const context = new AudioContext({ sampleRate: 16000 });
    const node = context.createScriptProcessor(1024, 1, 1);
    capture = { stream, context, node };
    window.__released = false;
    node.onaudioprocess = ({ inputBuffer }) => {
      if (!capture) return;
      const source = inputBuffer.getChannelData(0), pcm = new Int16Array(source.length);
      for (let i = 0; i < source.length; i++) pcm[i] = Math.round(Math.max(-1, Math.min(1, source[i])) * 32767);
      window.vi.audio(new Uint8Array(pcm.buffer));
    };
    const silent = context.createGain();
    silent.gain.value = 0;
    context.createMediaStreamSource(stream).connect(node).connect(silent).connect(context.destination);
    await context.resume();
    document.getElementById('toggle').textContent = 'Stop';
    document.getElementById('phase').textContent = 'Listening';
  } catch {
    window.__failure = 'Audio/UI operation failed';
    document.getElementById('phase').textContent = window.__failure;
  }
};
window.vi.onPhase((phase) => {
  document.getElementById('phase').textContent = phase;
  if (phase === 'Ready') document.getElementById('toggle').textContent = 'Start';
});
