const waveform = new VoiceWaveform(document.getElementById('wave'));
const labels = { preparing: 'Starting mic', recording: 'Listening', finishing: 'Finishing', cancelling: 'Cancelling' };
let nativePointer = false;
let recording = false;
let completedPointer;
const failure = (error) => {
  document.getElementById('message').textContent = 'Position not saved';
  document.getElementById('drag-handle').title = error.message;
};
const dragBinding = bindDragHandle(document.getElementById('drag-handle'), window.floatingVoice, failure,
  globalThis, () => !nativePointer);
window.floatingVoice.onPointerCancel(() => {
  dragBinding.cancel();
});
window.floatingVoice.onStatus((value) => {
  if (nativePointer !== value.nativePointer) {
    dragBinding.cancel();
  }
  nativePointer = value.nativePointer;
  recording = value.phase === 'recording';
  const elapsed = `${Math.floor(value.elapsedSeconds / 60)}:${String(value.elapsedSeconds % 60).padStart(2, '0')}`;
  document.getElementById('message').textContent = value.overlayControlError ? 'Mouse fallback'
    : value.phase === 'error' ? ({ 'input-confirmation': 'Input not confirmed', input: 'Input error',
      microphone: 'Audio interrupted', cloud: 'Connection error', provider: 'Provider setup error',
      'clipboard-busy': 'Clipboard busy', 'clipboard-format': 'Clipboard preserved',
      'clipboard-snapshot-failed': 'Clipboard unavailable', 'restore-failed': 'Review paste',
      'no-speech': 'No speech detected',
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
// Buttons use one DOM gesture stream. The polling observer is only a drag fallback.
for (const name of ['stop', 'cancel']) {
  const button = document.getElementById(name);
  let pressed, hovered = false;
  const action = name === 'stop' ? stop : cancel;
  button.addEventListener('pointerenter', (event) => { hovered = event.buttons === 0; });
  button.addEventListener('pointerleave', () => { hovered = false; pressed = undefined; });
  button.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    completedPointer = undefined;
    pressed = event.pointerId;
  });
  button.addEventListener('pointercancel', () => { pressed = undefined; hovered = false; });
  button.addEventListener('pointerup', (event) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    if (pressed !== event.pointerId && !hovered) return;
    pressed = undefined;
    completedPointer = { name, id: event.pointerId };
    void action();
  });
  button.onclick = (event) => {
    const completed = event.detail !== 0 && completedPointer?.name === name &&
      (event.pointerId === undefined || event.pointerId === completedPointer.id);
    completedPointer = undefined;
    if (!completed) void action();
  };
}
window.floatingVoice.onPointerDown(({ x, y }) => {
  if (!nativePointer) return;
  const target = document.elementFromPoint(x, y);
  if (target?.closest('#drag-handle')) {
    void window.floatingVoice.drag('start').then((reply) => {
      if (!reply.ok) throw new Error(reply.error);
    }).catch(failure);
  }
});
