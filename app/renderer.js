const byId = (id) => document.getElementById(id);
let capture;
let soundsEnabled = true;
let preferenceKey;
let recording = false;
let micTest;
let savedDeviceId = '';
const cues = new RecordingCues();
const waveform = new VoiceWaveform(byId('waveform'));

function cue(kind) {
  return soundsEnabled ? cues.play(kind).catch(() => {
    byId('preferences-result').textContent = 'Sound output unavailable; check your output device.';
    byId('preferences-result').classList.add('error');
  }) : Promise.resolve();
}

function showStatus(value) {
  recording = value.phase === 'recording';
  byId('version').textContent = `v${value.version}`;
  byId('status').textContent = value.message;
  byId('status').classList.toggle('error', value.phase === 'error');
  byId('input-state').textContent = ['idle', 'error'].includes(value.phase) ? '' : ['preparing', 'binding'].includes(value.inputState)
    ? 'Remembering the original window. No text is changed while recording.'
    : value.actualMode === 'preview' ? 'Preview only: this recording does not type into another app.'
      : 'Stop to paste once at your current caret in the original window.';
  byId('result').value = value.text;
  byId('consent').checked = value.consent;
  const busy = ['preparing', 'recording', 'finishing', 'cancelling'].includes(value.phase);
  byId('toggle').textContent = ['preparing', 'recording'].includes(value.phase) ? 'Stop recording' : 'Record preview';
  byId('toggle').disabled = !value.consent || ['finishing', 'cancelling'].includes(value.phase);
  byId('cancel').disabled = !busy;
  byId('copy').disabled = value.canCopy === undefined ? !value.text : !value.canCopy;
  byId('shortcut').textContent = value.shortcut.replace('Control', 'Ctrl').replace('Command', 'Cmd');
  byId('cancel-shortcut').textContent = value.cancelShortcut.replace('Control', 'Ctrl').replace('Command', 'Cmd');
  soundsEnabled = value.sounds;
  const nextKey = JSON.stringify([value.triggerMode, value.deviceId, value.autoCopy, value.sounds, value.openAtLogin, value.shortcut, value.cancelShortcut]);
  if (preferenceKey !== nextKey) {
    byId('trigger-mode').value = value.triggerMode;
    savedDeviceId = value.deviceId;
    selectDevice(savedDeviceId);
    byId('auto-copy').checked = value.autoCopy;
    byId('sounds').checked = value.sounds;
    byId('open-at-login').checked = value.openAtLogin;
    byId('record-shortcut').value = value.shortcut;
    byId('cancel-binding').value = value.cancelShortcut;
    preferenceKey = nextKey;
  }
  for (const id of ['trigger-mode', 'input-device', 'refresh-devices', 'auto-copy', 'sounds', 'record-shortcut', 'cancel-binding', 'save-preferences', 'check-shortcuts']) {
    byId(id).disabled = Boolean(busy || value.testingMic);
  }
  byId('test-mic').disabled = busy;
  byId('test-mic').textContent = value.testingMic ? 'Stop test' : 'Test Mic';
  byId('microphone-help').textContent = value.platform === 'darwin'
    ? 'In System Settings > Privacy & Security > Microphone, allow VI. Automatic paste also needs Accessibility.'
    : 'In Windows Settings > Privacy & security > Microphone, enable microphone access and let desktop apps access your microphone.';
  byId('open-at-login').disabled = busy || !value.loginManaged;
  byId('startup-state').textContent = !value.loginManaged ? 'Isolated test profile: startup registration disabled.'
    : value.loginEnabled ? 'Start at login: enabled. Recording never starts automatically.' : 'Start at login: currently disabled.';
  if (value.preferenceError || value.diagnosticsError || value.overlayControlError) {
    byId('preferences-result').textContent = [value.preferenceError, value.diagnosticsError, value.overlayControlError].filter(Boolean).join(' ');
    byId('preferences-result').classList.add('error');
  }
  if (value.phase !== 'recording') waveform.reset();
}

function displayError(error) {
  byId('preferences-result').textContent = error.message;
  byId('preferences-result').classList.add('error');
}

window.voice.providerOptions().then((options) => {
  byId('provider-state').textContent = options.available ? 'Service provider installed.' : 'Install a compatible service provider to transcribe.';
  byId('provider-endpoint').value = options.endpointOverride || '';
}).catch(displayError);
byId('save-provider').onclick = async () => {
  try { byId('provider-result').textContent = await window.voice.saveProvider(byId('provider-endpoint').value.trim()); }
  catch (error) { byId('provider-result').textContent = error.message; }
};

async function dispose(run) {
  run.stream?.getTracks().forEach((track) => track.stop());
  run.node?.disconnect();
  if (run.context && run.context.state !== 'closed') await run.context.close();
}

function audioConstraints(deviceId) {
  return { audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }, video: false };
}

window.voice.onStart(async (id, sounds, deviceId) => {
  soundsEnabled = sounds;
  const run = { id, stopping: false };
  capture = run;
  try {
    run.stream = await navigator.mediaDevices.getUserMedia(audioConstraints(deviceId));
    run.stream.getTracks().forEach((track) => { track.enabled = false; });
    if (capture !== run) { await dispose(run); return; }
    run.context = new AudioContext({ sampleRate: 16000 });
    if (run.context.sampleRate !== 16000) throw new Error('Unsupported microphone sample rate.');
    await run.context.audioWorklet.addModule('pcm-worklet.js');
    if (capture !== run) { await dispose(run); return; }
    run.node = new AudioWorkletNode(run.context, 'pcm16-capture');
    run.node.port.onmessage = async ({ data }) => {
      if (capture !== run) return;
      if (data.type === 'pcm') {
        window.voice.audio(id, new Uint8Array(data.buffer));
        window.voice.meter(id, data.level);
      }
      if (data.type === 'ended') {
        capture = undefined;
        const stopped = dispose(run);
        window.voice.ended(id);
        await stopped;
        await cue('stop');
      }
    };
    for (const track of run.stream.getTracks()) {
      track.onended = () => {
        if (capture === run && !run.stopping) {
          capture = undefined;
          void dispose(run);
          window.voice.microphoneError(id);
        }
      };
    }
    run.node.onprocessorerror = () => {
      if (capture === run) {
        capture = undefined;
        void dispose(run);
        window.voice.microphoneError(id);
      }
    };
    const source = run.context.createMediaStreamSource(run.stream);
    const silence = run.context.createGain();
    silence.gain.value = 0;
    source.connect(run.node).connect(silence).connect(run.context.destination);
    await run.context.resume();
    if (capture !== run) { await dispose(run); return; }
    await cue('start');
    if (capture !== run) { await dispose(run); return; }
    window.voice.ready(id);
    run.stream.getTracks().forEach((track) => { track.enabled = true; });
  } catch {
    if (capture === run) {
      capture = undefined;
      window.voice.microphoneError(id);
    }
    await dispose(run);
  }
});

window.voice.onStop((id) => {
  if (capture?.id !== id) return;
  capture.stopping = true;
  capture.node.port.postMessage('stop');
});
window.voice.onCancel(async (id, kind) => {
  if (capture?.id === id) {
    const previous = capture;
    capture = undefined;
    await dispose(previous);
  }
  await cue(kind);
});
window.voice.onStatus(showStatus);
window.voice.onMeter((level) => { if (recording) waveform.draw(level); });
byId('consent').onchange = () => window.voice.consent(byId('consent').checked).catch(displayError);
byId('toggle').onclick = () => window.voice.toggle().catch(displayError);
byId('cancel').onclick = () => window.voice.cancel().catch(displayError);
byId('copy').onclick = () => window.voice.copy().catch(displayError);
function selectDevice(id) {
  const select = byId('input-device');
  if (id && !Array.from(select.options).some((option) => option.value === id)) {
    select.add(new Option('Saved microphone (unavailable or permission not granted)', id));
  }
  select.value = id;
}
async function refreshDevices() {
  try {
    const selected = byId('input-device').value ?? savedDeviceId;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const select = byId('input-device');
    select.replaceChildren(new Option('System default', ''));
    for (const device of devices.filter((item) => item.kind === 'audioinput' && item.deviceId &&
      !['default', 'communications'].includes(item.deviceId))) {
      select.add(new Option(device.label || `Microphone ${select.options.length}`, device.deviceId));
    }
    selectDevice(selected);
    byId('device-result').textContent = 'Choose an input, then Save preferences. A missing selected device reports an error, not a silent switch.';
    byId('device-result').classList.remove('error');
  } catch {
    byId('device-result').textContent = 'Could not list microphones. Check Microphone privacy, then refresh.';
    byId('device-result').classList.add('error');
  }
}
async function stopMicTest(message = 'Microphone test stopped. No audio was saved or sent.') {
  const run = micTest;
  if (!run) return;
  micTest = undefined;
  clearTimeout(run.timer);
  cancelAnimationFrame(run.frame);
  try { await dispose(run); }
  finally {
    byId('mic-level').value = 0;
    byId('mic-test-result').textContent = message;
    if (run.started) await window.voice.endMicTest(run.id);
  }
}
byId('test-mic').onclick = () => preferenceAction(async () => {
  if (micTest) { await stopMicTest(); return 'Microphone test stopped.'; }
  const run = {};
  micTest = run;
  try {
    run.id = await window.voice.startMicTest();
    run.started = true;
    if (micTest !== run) { await window.voice.endMicTest(run.id); return 'Microphone test cancelled.'; }
    run.stream = await navigator.mediaDevices.getUserMedia(audioConstraints(byId('input-device').value));
    if (micTest !== run) { await dispose(run); return 'Microphone test cancelled.'; }
    run.context = new AudioContext();
    const source = run.context.createMediaStreamSource(run.stream);
    const analyser = run.context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    await run.context.resume();
    if (micTest !== run) { await dispose(run); return 'Microphone test cancelled.'; }
    const samples = new Float32Array(analyser.fftSize);
    let peak = 0;
    const draw = () => {
      if (micTest !== run) return;
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      peak = Math.max(peak, rms);
      byId('mic-level').value = Math.min(1, rms * 5);
      byId('mic-test-result').textContent = `Testing locally: level ${Math.round(rms * 100)}%. Speak into the selected microphone.`;
      run.frame = requestAnimationFrame(draw);
    };
    draw();
    run.timer = setTimeout(() => {
      if (micTest !== run) return;
      void stopMicTest(peak > 0.003 ? 'Test complete: microphone signal detected. No audio saved or sent.'
        : 'No microphone signal detected. Check the selected input, mute switch and privacy settings.').catch(displayError);
    }, 10000);
    for (const track of run.stream.getTracks()) track.onended = () => {
      if (micTest !== run) return;
      void stopMicTest('Microphone disconnected during the test.').catch(displayError);
    };
    await refreshDevices();
    return 'Microphone test runs locally for up to 10 seconds.';
  } catch {
    if (micTest !== run) { await dispose(run); return 'Microphone test cancelled.'; }
    await stopMicTest('Microphone unavailable. Check the selected input and privacy settings.');
    throw new Error('Microphone unavailable. Check the selected input and privacy settings.');
  }
});
window.voice.onMicTestStop((id) => {
  if (micTest?.id === id) void stopMicTest().catch(displayError);
});
byId('microphone-privacy').onclick = () => preferenceAction(async () => {
  await window.voice.microphonePrivacy();
  return 'Opened microphone privacy settings.';
});
byId('refresh-devices').onclick = refreshDevices;
function shortcutDraft() {
  return { shortcut: byId('record-shortcut').value, cancelShortcut: byId('cancel-binding').value };
}
async function preferenceAction(action) {
  byId('preferences-result').classList.remove('error');
  try { byId('preferences-result').textContent = await action(); }
  catch (error) {
    byId('preferences-result').classList.add('error');
    byId('preferences-result').textContent = error.message;
  }
}
byId('check-shortcuts').onclick = () => preferenceAction(() => window.voice.checkShortcuts(shortcutDraft()));
byId('save-preferences').onclick = () => preferenceAction(async () => {
  await window.voice.preferences({ ...shortcutDraft(), triggerMode: byId('trigger-mode').value,
    deviceId: byId('input-device').value,
    autoCopy: byId('auto-copy').checked, sounds: byId('sounds').checked, openAtLogin: byId('open-at-login').checked });
  return 'Preferences saved.';
});
window.voice.status().then(showStatus).catch(displayError);
navigator.mediaDevices.addEventListener('devicechange', () => { void refreshDevices(); });
void refreshDevices();
