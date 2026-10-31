const waveform = new VoiceWaveform(document.getElementById('wave'));
const labels = { preparing: 'Starting mic', recording: 'Listening', finishing: 'Finishing', cancelling: 'Cancelling' };
let nativePointer = false;
let recording = false;
let nativeButton;
const failure = (error) => {
  document.getElementById('message').textContent = 'Position not saved';
  document.getElementById('drag-handle').title = error.message;
};
const dragBinding = bindDragHandle(document.getElementById('drag-handle'), window.floatingVoice, failure,
  globalThis, () => !nativePointer);
window.floatingVoice.onPointerCancel(() => {
  dragBinding.cancel();
  nativeButton = undefined;
});
window.floatingVoice.onStatus((value) => {
  if (nativePointer !== value.nativePointer) {
    dragBinding.cancel();
    nativeButton = undefined;
  }
  nativePointer = value.nativePointer;
  recording = value.phase === 'recording';
  const elapsed = `${Math.floor(value.elapsedSeconds / 60)}:${String(value.elapsedSeconds % 60).padStart(2, '0')}`;
  document.getElementById('message').textContent = value.overlayControlError ? 'Mouse fallback'
    : value.phase === 'error' ? ({ 'input-confirmation': 'Input not confirmed', input: 'Input error',
      microphone: 'Audio interrupted', cloud: 'Connection error', 'no-speech': 'No speech detected',
      plugin: 'Result blocked by plugin' }[value.errorKind] || 'Stopped: error')
    : value.phase === 'done' ? value.insertionResult === 'preview'
      ? value.origin === 'preview' ? 'Preview ready' : 'Not pasted; copy' : 'Ready'
    : recording && ['preparing', 'binding'].includes(value.inputState) ? 'Binding input...'
    : recording && value.actualMode === 'preview' ? `Preview only ${elapsed}`
    : value.phase === 'recording' && !value.connectionReady ? `Local ${elapsed}`
    : value.phase === 'finishing' && !value.connectionReady ? 'Connecting...'
        : recording ? `Listening ${elapsed}` : labels[value.phase] || 'Ready';
  const warnings = value.pluginWarnings || [];
  if (warnings.length) document.getElementById('message').textContent += ' (plugin warning)';
  document.querySelector('.pill').title = [value.overlayControlError || value.message, ...warnings].join(' ');
  document.querySelector('.dot').classList.toggle('inactive', !recording);
  document.querySelector('.dot').classList.toggle('error', value.phase === 'error');
  const busy = ['preparing', 'recording'].includes(value.phase);
  document.getElementById('stop').disabled = ['finishing', 'cancelling'].includes(value.phase);
  document.getElementById('stop').textContent = busy ? '\u25a0' : '\u25cf';
  document.getElementById('stop').title = busy ? 'Stop and finish dictation' : 'Start dictation';
  document.getElementById('stop').setAttribute('aria-label', busy ? 'Stop and finish dictation' : 'Start dictation');
  document.getElementById('cancel').title = ['preparing', 'recording', 'finishing', 'cancelling'].includes(value.phase)
    ? 'Cancel dictation' : 'Hide floating window';
  if (!recording) waveform.reset();
});
window.floatingVoice.onMeter((level) => { if (recording) waveform.draw(level); });
async function stop() {
  if (document.getElementById('stop').disabled) return;
  const reply = await window.floatingVoice.stop();
  if (!reply.ok) document.getElementById('message').textContent = 'Open settings';
}
async function cancel() {
  const reply = await window.floatingVoice.cancel();
  if (!reply.ok) document.getElementById('message').textContent = 'Open settings';
}
const nativeHandled = (name) => nativePointer && nativeButton?.name === name && Date.now() - nativeButton.at < 1000;
document.getElementById('stop').onclick = () => { if (!nativeHandled('stop')) void stop(); };
document.getElementById('cancel').onclick = () => { if (!nativeHandled('cancel')) void cancel(); };
window.floatingVoice.onPointerDown(({ x, y }) => {
  if (!nativePointer) return;
  const target = document.elementFromPoint(x, y);
  if (target?.closest('#stop')) {
    nativeButton = { name: 'stop', at: Date.now() };
    void stop();
  } else if (target?.closest('#cancel')) {
    nativeButton = { name: 'cancel', at: Date.now() };
    void cancel();
  }
  else if (target?.closest('#drag-handle')) {
    void window.floatingVoice.drag('start').then((reply) => {
      if (!reply.ok) throw new Error(reply.error);
    }).catch(failure);
  }
});
