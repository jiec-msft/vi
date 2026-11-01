const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage,
  clipboard, screen, session, systemPreferences, powerMonitor, shell, utilityProcess, dialog } = require('electron');
const { readFile, writeFile, mkdir, rename } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { createSession, providerAvailable, readOverride } = require('./service-provider.cjs');
const { DesktopInput } = require('./desktop.cjs');
const { APP_ID, preferences, overlayPosition, applyLoginSettings } = require('./preferences.cjs');
const { ShortcutBindings, ShortcutPress, shortcutKeys } = require('./shortcuts.cjs');
const { OverlayDrag } = require('./overlay-drag.js');
const { AudioTurn } = require('./audio-turn.cjs');
const { OverlayPointer } = require('./overlay-pointer.cjs');
const { Diagnostics } = require('./diagnostics.cjs');
const { Registry } = require('./plugins/registry.cjs');
const { PluginRuntime } = require('./plugins/pipeline.cjs');
const { pluginPreferences, failure } = require('./plugins/manifest.cjs');
const { TranscriptOutput } = require('./transcript-output.cjs');

const uiUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;
const overlayUrl = pathToFileURL(path.join(__dirname, 'overlay.html')).href;
const profile = app.commandLine.getSwitchValue('user-data-dir');
if (profile) app.setPath('userData', path.resolve(profile));
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
let window, overlay, tray, desktop, manualToken, active;
let settings = preferences();
let preferenceError = '';
let loginEnabled = false;
let saveQueue = Promise.resolve();
let bindings;
let shortcutPress;
let testingMic = false;
let micTestTimer;
let quitting = false;
let status = { phase: 'idle', message: 'Enable cloud dictation, then use the global shortcut.', text: '' };
let checkingAuth = false;
let authProbe;
let overlayDrag;
let overlayMoveTimer;
let overlayPointer;
let diagnostics = { record() {}, flush: () => Promise.resolve() };
let diagnosticsError = '';
let overlayControlError = '';
let pluginRegistry;
const forkPlugin = (...args) => utilityProcess.fork(...args);
let pluginRuntime = new PluginRuntime([], forkPlugin);
let retainedOutput;
let pluginWarnings = [];
let pluginChanging = false;
let pluginLoading;
let startupStartedAt;
let startupComplete = false;

function startupStage(stage, state) {
  if (!startupComplete && startupStartedAt !== undefined) {
    diagnostics.record('startup-stage', { stage, state, elapsedMs: Date.now() - startupStartedAt });
  }
}

function snapshot() {
  const { plugins, ...publicSettings } = settings;
  return { ...status, ...publicSettings, version: app.getVersion(), preferenceError, loginEnabled, loginManaged: !profile,
    pluginCount: plugins.entries.filter((entry) => entry.enabled).length,
    pluginPrivacy: Boolean(active?.pipeline?.privacy),
    pluginWarnings: [...pluginWarnings], pluginChanging,
    canCopy: Boolean(!pluginChanging && status.text && (!active?.pipeline?.enabled || retainedOutput?.sealed?.outcome === 'approved')),
    canOriginal: Boolean(!active && retainedOutput?.raw !== undefined),
    resultId: retainedOutput?.sealed?.id,
    shortcutReady: bindings?.current.length === 2,
    actualMode: active ? active.target ? 'final'
      : active.origin === 'shortcut' ? 'pending' : 'preview' : status.actualMode || 'preview',
    inputState: active?.inputState || status.inputState || 'idle',
    insertionResult: status.insertionResult,
    origin: active?.origin || status.origin,
    connectionReady: Boolean(active?.audio?.connected),
    bufferedAudioBytes: active?.audio?.queuedBytes || 0,
    platform: process.platform, testingMic: Boolean(testingMic), checkingAuth,
    elapsedSeconds: active?.captureStartedAt !== undefined
      ? Math.max(0, Math.floor((Date.now() - active.captureStartedAt) / 1000)) : 0,
    completedSegments: active?.audio?.completedSegments || status.completedSegments || 0,
    frozenTextChars: active?.audio?.committedText.length || 0,
    segmentFinalizing: Boolean(active?.audio?.segmentFinalizing),
    nativePointer: Boolean(overlayPointer?.ready),
    nativePointerState: overlayPointer?.state || 'fallback',
    nativePointerRestarts: overlayPointer?.restarts || 0,
    overlayControlError, diagnosticsError };
}

function logEvent(event, run, extra = {}) {
  diagnostics.record(event, { turn: run?.id, elapsedMs: run ? Date.now() - run.startedAt : 0,
    audioBytes: run?.audio?.bytes, queuedBytes: run?.audio?.queuedBytes, revisions: run?.revisions || 0,
    origin: run?.origin, mode: run?.target ? 'final' : run?.origin === 'preview' ? 'preview' : 'pending',
    writes: run?.onceWrites || 0, segments: run?.audio?.completedSegments || 0, ...extra });
}

function showSettings() {
  if (!window || window.isDestroyed()) return;
  startupStage('window-show', 'begin');
  window.setSkipTaskbar(false);
  if (window.isMinimized()) window.restore();
  window.show();
  startupStage('window-show', 'end');
  startupStage('window-focus', 'begin');
  window.focus();
  startupStage('window-focus', 'end');
  if (process.platform === 'win32' && desktop) {
    startupStage('window-order', 'begin');
    return desktop.settleWindow(window.getNativeWindowHandle()).then((placedBehind) => {
      startupStage('window-order', 'end');
      logEvent('window-shown', undefined, { placedBehind });
    }).catch((error) => {
      startupStage('window-order', 'end');
      preferenceError = error.message;
      console.error('Settings window ordering failed.');
      logEvent('error', undefined, { reason: 'window-order' });
      publish(status.phase, status.message);
    });
  }
}

function saveSettings(patch) {
  const save = async () => {
    const next = preferences({ ...settings, ...patch });
    const file = path.join(app.getPath('userData'), 'settings.json');
    await mkdir(app.getPath('userData'), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(next));
    await rename(`${file}.tmp`, file);
    settings = next;
  };
  const result = saveQueue.then(save, save);
  saveQueue = result;
  return result;
}

function configureLogin() {
  loginEnabled = applyLoginSettings(app, settings, Boolean(profile));
}

async function listPlugins() {
  let found;
  try { found = await pluginRegistry.discover(); }
  catch (error) { warnPlugin({ pluginId: 'host', code: 'discovery-failed', stage: 'load' }); found = []; }
  for (const entry of settings.plugins.entries) {
    if (!found.some((item) => item.manifest.id === entry.id)) {
      found.push({ manifest: { id: entry.id }, unavailable: true });
    }
  }
  return { plugins: found.map((descriptor) => ({
    id: descriptor.manifest.id, enabled: settings.plugins.entries.some((entry) =>
      entry.id === descriptor.manifest.id && entry.enabled),
    unavailable: Boolean(descriptor.unavailable),
  })) };
}

function warnPlugin({ pluginId, code, cause, stage }) {
  const message = `Warning: plugin ${pluginId} skipped (${stage}: ${code}). Dictation continues without this plugin.` +
    (code === 'package-changed' ? ' Disable and re-enable it to approve changed code.' : '');
  if (!pluginWarnings.includes(message)) {
    pluginWarnings.push(message);
    diagnostics.record('plugin-warning', { pluginId, pluginError: code, pluginCause: cause, hook: stage });
    publish(status.phase, status.message);
  }
}

async function closePlugins(runtime) {
  try { await runtime.retire(); }
  catch (error) { warnPlugin({ pluginId: error.pluginId || 'host', code: 'termination-failed', stage: 'close' }); }
}

async function prunePluginCache() {
  try { await pluginRegistry?.pruneCache?.(); }
  catch (error) { warnPlugin({ pluginId: 'host', code: 'cache-cleanup-failed', stage: 'close' }); }
}

async function configuredRuntime(configuration) {
  const descriptors = [];
  let incomplete = false;
  for (const entry of configuration.entries.filter((item) => item.enabled)) {
    try { descriptors.push(await pluginRegistry.resolve(entry, configuration.trustedLocal)); }
    catch (error) {
      incomplete = true;
      warnPlugin({ pluginId: entry.id, code: error.pluginFailure ? error.code : 'load-failed', stage: 'load' });
    }
  }
  const runtime = new PluginRuntime(descriptors, forkPlugin, (data) => diagnostics.record('plugin-call', data), warnPlugin);
  // An unavailable manifest may have requested private previews; keep them hidden.
  runtime.suppressUnprocessed = incomplete;
  return runtime;
}

async function initializePlugins() {
  try {
    pluginRegistry = new Registry(path.join(app.getPath('userData'), 'plugins'));
    await pluginRegistry.initialize(settings.plugins.entries);
    pluginRuntime = await configuredRuntime(settings.plugins);
    await pluginRuntime.warmup();
    await prunePluginCache();
  } catch (error) {
    warnPlugin({ pluginId: 'host', code: 'initialization-failed', stage: 'init' });
  }
}

async function replacePlugins(configuration, validate = true) {
  const next = pluginPreferences(configuration);
  pluginWarnings = [];
  retainedOutput = undefined;
  publish('idle', 'Updating plugins; previous transcript cleared.', '');
  const runtime = validate ? await configuredRuntime(next) : new PluginRuntime([], forkPlugin);
  try {
    await runtime.warmup();
    await closePlugins(pluginRuntime);
    await saveSettings({ plugins: next });
  } catch (error) {
    await closePlugins(runtime);
    throw error;
  }
  pluginRuntime = runtime;
  await prunePluginCache();
  publish('idle', 'Plugins saved. Changes apply to the next recording.', '');
}

async function reloadPluginFiles(signal) {
  const runtime = await configuredRuntime(settings.plugins);
  if (signal?.aborted || quitting) {
    await closePlugins(runtime);
    await prunePluginCache();
    return;
  }
  const identity = (value) => JSON.stringify({ privacy: Boolean(value.suppressUnprocessed),
    plugins: value.descriptors.map(({ hash, config }) => ({ hash, config })) });
  if (identity(runtime) === identity(pluginRuntime)) {
    await closePlugins(runtime);
    await pluginRuntime.warmup();
    await prunePluginCache();
    return;
  }
  try {
    await runtime.warmup();
    await closePlugins(pluginRuntime);
  } catch (error) {
    await closePlugins(runtime);
    throw error;
  }
  pluginRuntime = runtime;
  await prunePluginCache();
}

async function saveOverlayPosition(position) {
  try { await saveSettings({ overlay: { x: position.x, y: position.y } }); }
  catch {
    preferenceError = 'Could not save the floating window position.';
    publish(status.phase, status.message);
    throw new Error(preferenceError);
  }
}

function publish(phase, message, text = status.text, details = {}) {
  const changed = phase !== status.phase;
  status = { ...(changed ? {} : status), phase, message, text,
    stopReason: active?.stopReason ?? (changed ? undefined : status.stopReason), ...details };
  for (const target of [window, overlay]) {
    if (target && !target.isDestroyed()) target.webContents.send('status', snapshot());
  }
  tray?.setToolTip(`VI: ${phase} (v${app.getVersion()})`);
  const visible = settings.consent || phase === 'error';
  const bindingInput = pluginLoading?.fromShortcut || active?.origin === 'shortcut' &&
    ['preparing', 'binding'].includes(active.inputState) && ['preparing', 'recording'].includes(phase);
  if (!quitting && visible) {
    if (overlay && !overlay.isVisible() && !bindingInput) overlay.showInactive();
  } else if (overlay?.isVisible()) overlay.hide();
}

function trusted(event, allowOverlay = false) {
  if (!(event.sender === window?.webContents && event.senderFrame?.url === uiUrl) &&
      !(allowOverlay && event.sender === overlay?.webContents && event.senderFrame?.url === overlayUrl)) {
    throw new Error('Untrusted application request.');
  }
}

async function abort(message = 'Dictation cancelled.', failed = false, reason = 'unknown') {
  if (pluginLoading) {
    pluginLoading.controller.abort();
    logEvent(failed ? 'error' : 'cancel', undefined, { reason: failed ? reason : 'cancel' });
  }
  const run = active;
  if (!run) {
    pluginLoading?.controller.abort();
    publish(failed ? 'error' : 'idle', message);
    return;
  }
  if (run.aborting) return run.aborting;
  const clipboardWarning = run.copyPending || run.deliveryPending
    ? ' Clipboard delivery was already requested and may finish. Review the target; cancellation does not undo a paste.' : '';
  run.cancelled = true;
  if (run.pipeline.enabled && !retainedOutput?.sealed) {
    status.text = '';
    if (failed && run.pipeline.privacy && !message.startsWith('Plugin ')) message = `Dictation failed (${reason}).`;
  }
  logEvent(failed ? 'error' : 'cancel', run, { reason: failed ? reason : 'cancel' });
  run.controller.abort();
  for (const timer of [run.audioTimer, run.stopTimer, run.recordingTimer]) clearTimeout(timer);
  clearInterval(run.watchdog);
  run.audio?.cancel();
  window.webContents.send('capture-cancel', run.id, failed ? 'error' : 'cancel');
  publish('cancelling', 'Stopping microphone. Existing text is not changed.');
  run.aborting = (async () => {
    if (run.deliveryPending) await run.deliveryPending.catch(() => {});
    try { await run.pipeline.cancelled; }
    catch {
      warnPlugin({ pluginId: 'host', code: 'termination-failed', stage: 'close' });
    }
    if (active === run) {
      active = undefined;
      publish(failed ? 'error' : 'idle',
        message + (failed ? ' Available text is kept in preview.' : '') + clipboardWarning,
        status.text, { errorKind: reason });
    }
  })();
  return run.aborting;
}

async function begin(fromShortcut) {
  if (quitting) return;
  if (testingMic) {
    publish('idle', 'Stop the microphone test before starting dictation.');
    return;
  }
  if (checkingAuth) {
    publish('idle', 'Wait for the provider access check to finish before recording.');
    return;
  }
  if (pluginChanging) {
    if (pluginLoading) return abort();
    publish('error', 'Wait for plugin configuration to finish.', '');
    return;
  }
  if (active) {
    if (!active.stopRequested && !active.cancelled) requestStop(active);
    return;
  }
  if (!settings.consent) {
    showSettings();
    publish('idle', 'Accept the cloud audio notice before starting dictation.');
    return;
  }
  if (!providerAvailable()) {
    showSettings();
    publish('error', 'Install a compatible service provider before recording.', '');
    return;
  }
  pluginWarnings = [];
  pluginRuntime.onWarning = warnPlugin;
  let targetCapture;
  if (pluginRegistry) {
    pluginChanging = true;
    const loading = new AbortController();
    pluginLoading = { controller: loading, fromShortcut };
    if (fromShortcut) {
      targetCapture = desktop.capture(loading.signal);
      void targetCapture.catch((error) => {
        if (!loading.signal.aborted) logEvent('input-error', undefined, { reason: error.code || 'native-error', check: error.check });
      });
    }
    retainedOutput = undefined;
    publish('preparing', 'Loading plugin configuration...', '');
    try { await reloadPluginFiles(loading.signal); }
    catch (error) {
      warnPlugin({ pluginId: 'host', code: 'load-failed', stage: 'load' });
      await closePlugins(pluginRuntime);
      pluginRuntime = new PluginRuntime([], forkPlugin, undefined, warnPlugin);
      pluginRuntime.suppressUnprocessed = true;
    } finally {
      pluginChanging = false;
      pluginLoading = undefined;
      if (!fromShortcut || status.phase === 'error' || loading.signal.aborted) publish(status.phase, status.message);
    }
    if (quitting || loading.signal.aborted || !settings.consent) return;
  }
  const run = { id: randomUUID(), autoCopy: settings.autoCopy, controller: new AbortController(), startedAt: Date.now(),
    origin: fromShortcut ? 'shortcut' : 'preview', inputState: fromShortcut ? 'preparing' : 'preview' };
  retainedOutput = undefined;
  try { run.pipeline = pluginRuntime.begin(run.id, settings.plugins.profile, run.controller.signal); }
  catch (error) {
    warnPlugin({ pluginId: 'host', code: 'start-failed', stage: 'init' });
    pluginRuntime = new PluginRuntime([], forkPlugin, undefined, warnPlugin);
    pluginRuntime.suppressUnprocessed = true;
    run.pipeline = pluginRuntime.begin(run.id, settings.plugins.profile, run.controller.signal);
  }
  run.output = new TranscriptOutput(run.pipeline);
  active = run;
  logEvent('turn-start', run);
  run.audio = new AudioTurn({
    onFailure: (error) => { if (active === run && !run.cancelled) void abort(error.message, true, 'cloud'); },
    onConnected: () => { logEvent('cloud-ready', run); updateRecordingStatus(run); },
    onSegmentState: () => {
      if (active !== run || run.cancelled) return;
      if (!run.audio.segmentFinalizing) previewTranscript(run, run.audio.committedText);
      updateRecordingStatus(run);
    },
    onSegment: async (text, index, audioBytes) => {
      if (active !== run || run.cancelled) return;
      logEvent('segment-final', run, { segment: index, segmentAudioBytes: audioBytes, transcriptChars: text.length });
    },
  });
  publish('preparing', 'Starting microphone; connecting to cloud in parallel...', '');
  run.audioTimer = setTimeout(() => {
    if (active === run && !run.cancelled) void abort('Microphone did not start in time.', true, 'microphone');
  }, 12000);
  void startMicrophone(run).catch((error) => {
    if (active === run && !run.cancelled) void abort(error.message, true, 'microphone');
  });
  run.prepared = prepareInput(run, fromShortcut, targetCapture);
  void run.prepared.catch((error) => {
    if (active === run && !run.cancelled) void abort(error.message, true, error.pluginFailure ? 'plugin' : 'input');
  });
  void connectProvider(run);
  return run;
}

function previewTranscript(run, text) {
  if (active !== run || run.cancelled || run.stopRequested) return;
  if (!run.pipeline.enabled) { publish(status.phase, status.message, text); return; }
  run.pipeline.preview(text, (output) => {
    if (active === run && !run.cancelled && !run.stopRequested) publish(status.phase, status.message, output);
  }, (error) => {
    if (active === run && !run.cancelled) publish(status.phase, error.message, '');
  });
}

async function startMicrophone(run) {
  if (process.platform === 'darwin' && !(await systemPreferences.askForMediaAccess('microphone'))) {
    throw new Error('Microphone permission denied. Enable it in macOS Privacy & Security.');
  }
  if (active === run && !run.cancelled) window.webContents.send('capture-start', run.id, settings.sounds, settings.deviceId);
}

async function prepareInput(run, fromShortcut, targetCapture) {
  if (fromShortcut) {
    const target = await (targetCapture || desktop.capture(run.controller.signal));
    if (active !== run || run.cancelled) return;
    if (target.pid === process.pid) {
      logEvent('input-skipped', run, { reason: 'app-focused' });
      throw new Error('Focus a text field in another app before using the dictation shortcut. Record preview does not type into other apps.');
    }
    run.target = target;
    run.inputState = 'ready';
    logEvent('input-target', run);
    logEvent('input-ready', run);
  }
  if (active !== run || run.cancelled) return;
  updateRecordingStatus(run);
}

async function connectProvider(run) {
  try {
    run.session = createSession();
    run.session.on('failure', (error) => {
      if (active === run && !run.cancelled) void abort(error.message, true, 'cloud');
    });
    run.session.on('partial', (text) => {
      if (active !== run || run.cancelled) return;
      run.revisions = (run.revisions || 0) + 1;
      try { previewTranscript(run, run.audio.preview(text)); }
      catch (error) { run.audio.fail(error); }
    });
    run.audio.connect(run.session, run.prepared);
  } catch (error) {
    if (active === run && !run.cancelled) run.audio.fail(error);
  }
}

function updateRecordingStatus(run) {
  if (active !== run || run.cancelled || !run.captureReady || run.stopRequested) return;
  publish('recording', !run.audio.connected
    ? 'Recording locally while provider connects. Speech is buffered in memory.'
    : run.target ? 'Listening. Stop to paste the final result at your current caret in the original window.'
      : 'Recording preview. Stop to get the final result; no automatic paste.');
}

function stopMicrophone(run) {
  if (!run.captureReady || run.captureEnded || run.stopSent) return;
  run.stopSent = true;
  window.webContents.send('capture-stop', run.id);
  run.stopTimer = setTimeout(() => {
    if (active === run && !run.cancelled) void abort('Microphone did not stop in time.', true, 'microphone');
  }, 4000);
}

function requestStop(run, message, reason = 'user') {
  if (active !== run || run.cancelled || run.stopRequested) return;
  run.stopRequested = true;
  run.pipeline.stopPreview();
  run.stopReason = reason;
  logEvent('stop', run, { reason });
  clearTimeout(run.recordingTimer);
  clearInterval(run.watchdog);
  run.session?.stopRecordingDeadline();
  publish('finishing', message || (run.audio.connected
    ? 'Recording stopped. Finishing transcription...'
    : 'Recording stopped. Still connecting; recorded speech will be sent when ready.'));
  stopMicrophone(run);
}

async function finalize(run) {
  clearTimeout(run.stopTimer);
  clearTimeout(run.recordingTimer);
  try {
    const [raw] = await Promise.all([run.audio.finish(), run.prepared]);
    if (active !== run || run.cancelled) return;
    if (!raw.trim()) throw Object.assign(new Error('No speech was recognized.'), { code: 'no-speech' });
    const sealed = await run.pipeline.final(raw);
    if (active !== run || run.cancelled) return;
    run.output.accept(raw, sealed);
    retainedOutput = run.output;
    const text = sealed.text;
    if (sealed.outcome === 'suppressed') {
      logEvent('done', run, { outcome: 'suppressed', transcriptChars: 0 });
      active = undefined;
      publish('done', 'Result filtered; nothing to deliver.', '', { insertionResult: 'suppressed' });
      return;
    }
    publish('finishing', 'Checking the original input target...', text);
    let result, inputError, skippedReason;
    try {
      if (run.target) {
        const current = await desktop.capture(run.controller.signal);
        if (active !== run || run.cancelled) return;
        logEvent('input-focus-return', run, { ownAppFocused: current.pid === process.pid,
          mainWindowVisible: window.isVisible() });
        // Our own review/Stop window must not block delivery to the user's original editor.
        if (current.pid === process.pid) {
          if (process.platform === 'darwin') app.hide();
          else {
            // Windows can keep a hidden HWND foreground; minimize performs the normal focus handoff.
            window.minimize();
          }
          logEvent('input-focus-return', run, { ownAppFocused: true, mainWindowVisible: window.isVisible() });
        }
      }
      run.deliveryPending = desktop.paste(text, run.target, run.controller.signal, (reason, check) => {
        skippedReason = reason;
        run.inputCheck = check;
        logEvent('input-skipped', run, { reason, check });
      });
      result = { kind: await run.deliveryPending ? 'requested' : 'preview' };
    } catch (error) {
      inputError = error;
      logEvent('input-error', run, { reason: error.code || 'native-error', check: error.check });
    } finally { run.deliveryPending = undefined; }
    if (active !== run || run.cancelled) return;
    if (!inputError && result.kind === 'requested') run.onceWrites = 1;
    let copyFailed = false;
    if (run.autoCopy) {
      publish('finishing', 'Copying the final transcript to the clipboard...', text);
      run.copyPending = true;
      try { await clipboard.writeText(text); }
      catch {
        copyFailed = true;
        logEvent('error', run, { reason: 'clipboard-copy' });
      }
      finally { run.copyPending = false; }
    }
    if (active !== run || run.cancelled) return;
    const copyMessage = !run.autoCopy ? ''
      : copyFailed ? ' Automatic clipboard copy failed; use Copy result to try again.'
        : ' Final transcript copied to clipboard.';
    if (inputError) {
      await abort(`${inputError.message}${copyMessage}`, true, 'input');
      return;
    }
    logEvent('done', run, { reason: skippedReason || run.stopReason, outcome: result.kind, transcriptChars: text.length });
    const actualMode = snapshot().actualMode;
    const completedSegments = run.audio.completedSegments;
    active = undefined;
    const message = result.kind === 'requested'
      ? 'Paste requested in the original window. Ready for the next recording.'
        : run.origin === 'preview' ? 'Preview transcript ready. No automatic typing was requested.'
          : `Automatic paste skipped (${[skippedReason || 'target-changed', run.inputCheck].filter(Boolean).join(': ')}).`;
    const clipboardMessage = run.autoCopy ? copyMessage
      : result.kind === 'requested' ? ' The previous clipboard was restored unless a newer copy replaced it.'
        : ' Use Copy result to copy the final transcript.';
    publish(copyFailed ? 'error' : 'done', message + clipboardMessage, text,
      { stopReason: run.stopReason, insertionResult: result.kind,
        actualMode, inputState: run.inputState, origin: run.origin, completedSegments });
  } catch (error) {
    if (active === run && !run.cancelled) await abort(error.message, true,
      error.pluginFailure ? 'plugin' : error.code === 'no-speech' ? 'no-speech' : 'input');
  }
}

async function finishOverlayInteraction() {
  const moving = overlayDrag?.active;
  const saved = overlayDrag?.finish();
  if (moving) logEvent('drag-end', active);
  await saved;
}

function cancelOverlayInteraction() {
  const moving = overlayDrag?.active;
  overlayDrag?.cancel();
  if (moving) logEvent('drag-end', active, { reason: 'cancelled' });
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('overlay-pointer-cancel');
}

function publishOverlayPointer() {
  for (const target of [window, overlay]) {
    if (target && !target.isDestroyed()) target.webContents.send('status', snapshot());
  }
}

function observeOverlayPointer(event) {
  if (event.type === 'ready' || event.type === 'suspended') {
    cancelOverlayInteraction();
    overlayControlError = event.type === 'ready' ? ''
      : 'Native mouse input is temporarily unavailable. Mouse fallback and shortcuts remain available.';
    publishOverlayPointer();
    return;
  }
  if (event.type === 'cancel') { cancelOverlayInteraction(); return; }
  if (event.type === 'down') {
    if (quitting || overlay.isDestroyed() || !overlay.isVisible()) return;
    logEvent('overlay-down', active);
    const point = screen.screenToDipPoint({ x: event.x, y: event.y });
    const bounds = overlay.getBounds();
    overlay.webContents.send('overlay-pointer-down', { x: point.x - bounds.x, y: point.y - bounds.y });
  } else if (event.type === 'move') {
    try { overlayDrag.move(); }
    catch (error) {
      cancelOverlayInteraction();
      overlayControlError = error.message;
      console.error('Floating window movement interrupted.');
      logEvent('error', active, { reason: 'overlay-cursor' });
      publishOverlayPointer();
    }
  }
  else if (event.type === 'up') {
    void finishOverlayInteraction().catch((error) => console.error(error.message));
  }
}

function installIpc() {
  const handle = (channel, action, allowOverlay = false) => ipcMain.handle(channel, async (event, ...args) => {
    trusted(event, allowOverlay);
    try {
      return { ok: true, value: await action(...args) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  handle('get-status', () => snapshot(), true);
  handle('get-provider-options', () => ({ available: providerAvailable(), ...readOverride() }));
  handle('save-provider-options', async (endpointOverride) => {
    if (active || testingMic || pluginChanging) throw new Error('Stop recording or testing before changing providers.');
    if (typeof endpointOverride !== 'string' || endpointOverride.length > 4096) throw new Error('Invalid endpoint override.');
    if (endpointOverride) {
      const target = new URL(endpointOverride);
      if (target.protocol !== 'wss:' && !(target.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) ||
          target.username || target.password || target.hash) throw new Error('Use a secure compatible service endpoint.');
      const answer = await dialog.showMessageBox(window, { type: 'warning',
        buttons: ['Cancel', 'Save trusted endpoint'], defaultId: 0, cancelId: 0,
        message: 'Trust this provider endpoint?',
        detail: 'The selected provider may send credentials and speech to this address.' });
      if (answer.response !== 1) throw new Error('Endpoint change cancelled.');
    }
    const location = path.join(app.getPath('userData'), 'provider-options.json');
    await writeFile(`${location}.tmp`, JSON.stringify({ endpointOverride }));
    await rename(`${location}.tmp`, location);
    return 'Provider options saved for the next recording.';
  });
  if (app.commandLine.getSwitchValue('ci-mode') === 'smoke') {
    handle('ci-quit', () => { setTimeout(() => app.quit(), 100); });
  }
  const idlePlugins = async (action) => {
    if (active || testingMic || checkingAuth || pluginChanging) throw new Error('Stop dictation, tests and access checks before changing plugins.');
    pluginChanging = true;
    publish(status.phase, status.message);
    try { return await action(); }
    finally { pluginChanging = false; publish(status.phase, status.message); }
  };
  handle('get-plugins', () => listPlugins());
  handle('set-plugin-enabled', (id, enabled) => idlePlugins(async () => {
    if (typeof id !== 'string' || typeof enabled !== 'boolean') throw failure('invalid-settings');
    let entries = [...settings.plugins.entries], trustedLocal = settings.plugins.trustedLocal;
    const index = entries.findIndex((entry) => entry.id === id);
    if (!enabled) {
      if (index < 0) throw failure('unregistered-package');
      entries[index] = { id, hash: entries[index].hash, enabled: false };
    } else {
      const descriptor = (await pluginRegistry.discover()).find((item) => item.manifest.id === id);
      if (!descriptor || descriptor.unavailable) throw failure('invalid-package');
      if (!descriptor.builtin && (!entries[index]?.enabled || entries[index].hash !== descriptor.hash)) {
        const answer = await dialog.showMessageBox(window, { type: 'warning', buttons: ['Cancel', 'Enable trusted plugin'],
          defaultId: 0, cancelId: 0, message: `Enable ${id}?`,
          detail: `Local code can read files, use the network and start processes as your user. Not sandboxed. SHA-256: ${descriptor.hash}` });
        if (answer.response !== 1) throw failure('trust-required');
        trustedLocal = true;
      }
      const entry = { id, hash: descriptor.hash, enabled: true };
      if (index < 0) entries.push(entry);
      else entries[index] = entry;
    }
    // Disabling must remain possible even if other enabled plugins have invalid files.
    await replacePlugins({ ...settings.plugins, trustedLocal, entries }, enabled);
    return listPlugins();
  }));
  handle('set-consent', async (value) => {
    if (typeof value !== 'boolean') throw new Error('Invalid consent value.');
    if (active || pluginLoading) await abort();
    if (!value) authProbe?.cancel();
    await saveSettings({ consent: value });
    try { configureLogin(); preferenceError = ''; }
    catch (error) { preferenceError = error.message; }
    publish('idle', value ? 'Ready. Focus a text field and use the global shortcut.' : 'Cloud dictation disabled.');
  });
  handle('check-shortcuts', (patch) => {
    const next = preferences({ ...settings, shortcut: patch?.shortcut, cancelShortcut: patch?.cancelShortcut });
    bindings.check([next.shortcut, next.cancelShortcut]);
    return 'Both shortcuts are available. OS registration cannot identify the app owning a conflicting shortcut.';
  });
  handle('save-preferences', async (patch) => {
    if (active || testingMic || checkingAuth || pluginChanging) throw new Error('Stop dictation, microphone tests and access checks before changing preferences.');
    if (!patch || typeof patch !== 'object') throw new Error('Invalid preferences.');
    const changes = {};
    for (const key of ['autoCopy', 'sounds', 'openAtLogin', 'shortcut', 'cancelShortcut', 'deviceId', 'triggerMode']) {
      if (patch[key] !== undefined) changes[key] = patch[key];
    }
    const next = preferences({ ...settings, ...changes });
    shortcutKeys(next.shortcut);
    const previous = [settings.shortcut, settings.cancelShortcut];
    bindings.install([next.shortcut, next.cancelShortcut]);
    try { await saveSettings(changes); }
    catch (error) {
      try { bindings.install(previous); }
      catch (restore) { throw new Error(`Settings were not saved. ${restore.message}`); }
      throw error;
    }
    try { configureLogin(); preferenceError = ''; }
    catch (error) { preferenceError = error.message; }
    publish('idle', 'Preferences saved. Focus a text field to dictate.');
    if (preferenceError) throw new Error(`Preferences saved, but ${preferenceError}`);
    return snapshot();
  });
  handle('toggle', async () => { await begin(false); });
  handle('overlay-stop', async () => {
    if (pluginLoading) { await abort(); return; }
    if (active && !active.stopRequested) requestStop(active);
    else if (!active) await begin(true);
  }, true);
  handle('overlay-drag', (action) => {
    if (action === 'start') {
      if (overlayPointer?.ready && !overlayPointer.pressed) return false;
      const started = !quitting && overlayDrag.start();
      if (started) {
        logEvent('drag-start', active);
        clearTimeout(overlayMoveTimer);
        overlayMoveTimer = undefined;
      }
      return started;
    }
    if (action === 'move') return overlayDrag.move();
    if (action === 'end') return finishOverlayInteraction();
    if (action === 'cancel') return cancelOverlayInteraction();
    throw new Error('Invalid floating-window drag operation.');
  }, true);
  handle('cancel', () => {
    if (active || pluginLoading) return abort();
    overlay?.hide();
  }, true);
  handle('copy-result', async () => {
    if (pluginChanging) throw new Error('Wait for plugin configuration to finish.');
    if (active?.pipeline.enabled) throw new Error('Wait for an approved final result before copying.');
    if (retainedOutput) { await clipboard.writeText(retainedOutput.copy()); return; }
    if (settings.plugins.entries.some((entry) => entry.enabled)) throw new Error('No approved transcript to copy.');
    if (!status.text) throw new Error('No transcript to copy.');
    await clipboard.writeText(status.text);
  });
  handle('get-original', () => {
    if (active || pluginChanging || !retainedOutput) throw new Error('Original transcript is unavailable.');
    return { text: retainedOutput.original(), resultId: retainedOutput.sealed.id };
  });
  handle('copy-original', async () => {
    if (active || pluginChanging || !retainedOutput) throw new Error('Original transcript is unavailable.');
    const output = retainedOutput;
    const original = output.original();
    const answer = await dialog.showMessageBox(window, { type: 'warning', buttons: ['Cancel', 'Copy unprocessed original'],
      defaultId: 0, cancelId: 0, message: 'This bypasses text processing. Copy the original transcript?' });
    if (answer.response === 1 && !active && !pluginChanging && retainedOutput === output) {
      await clipboard.writeText(original);
    }
  });
  handle('microphone-privacy', () => shell.openExternal(process.platform === 'win32'
    ? 'ms-settings:privacy-microphone' : 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'));
  handle('microphone-test-start', async () => {
    if (active || testingMic || checkingAuth || pluginChanging) throw new Error('Stop dictation or the current test first.');
    const id = randomUUID();
    testingMic = id;
    try {
      if (process.platform === 'darwin' && !(await systemPreferences.askForMediaAccess('microphone'))) {
        throw new Error('Microphone permission denied. Open Microphone privacy settings.');
      }
      micTestTimer = setTimeout(() => window.webContents.send('microphone-test-stop', id), 11000);
      publish(status.phase, status.message);
      return id;
    } catch (error) { testingMic = false; throw error; }
  });
  handle('microphone-test-end', (id) => {
    if (typeof id !== 'string') throw new Error('Invalid microphone test ID.');
    if (id !== testingMic) return false;
    testingMic = false;
    clearTimeout(micTestTimer);
    publish(status.phase, status.message);
    return true;
  });
  const onCapture = (channel, action) => ipcMain.on(channel, (event, id, data) => {
    try {
      trusted(event);
      if (id !== active?.id || active.cancelled) return;
      action(active, data);
    } catch (error) {
      void abort(error.message, true);
    }
  });
  onCapture('capture-ready', (run) => {
    if (run.captureReady) return;
    run.captureReady = true;
    run.captureStartedAt = Date.now();
    run.lastAudioAt = run.captureStartedAt;
    logEvent('capture-ready', run);
    clearTimeout(run.audioTimer);
    if (run.stopRequested) { stopMicrophone(run); return; }
    run.watchdog = setInterval(() => {
      if (active !== run || run.cancelled || run.stopRequested) return;
      if (Date.now() - run.lastAudioAt >= 4000) {
        void abort('Microphone audio stopped arriving. Check your input device before starting again.', true, 'microphone');
      } else updateRecordingStatus(run);
    }, 1000);
    updateRecordingStatus(run);
  });
  onCapture('pcm', (run, data) => {
    if (!['recording', 'finishing'].includes(status.phase)) return;
    if (!(data instanceof Uint8Array) || data.byteLength > 32000) throw new Error('Invalid audio IPC payload.');
    if (!run.captureReady) return;
    run.lastAudioAt = Date.now();
    run.audio.push(Buffer.from(data));
  });
  onCapture('meter', (_run, level) => {
    if (typeof level !== 'number' || !Number.isFinite(level) || level < 0 || level > 1) {
      throw new Error('Invalid microphone level.');
    }
    if (status.phase !== 'recording') return;
    for (const target of [window, overlay]) target.webContents.send('meter', level);
  });
  onCapture('capture-ended', (run) => {
    if (status.phase !== 'finishing') throw new Error('Microphone stopped unexpectedly.');
    if (run.captureEnded) return;
    run.captureEnded = true;
    logEvent('capture-ended', run);
    void finalize(run);
  });
  onCapture('capture-error', () => abort('Microphone unavailable or disconnected. Check OS permissions and your default input device.', true, 'microphone'));
}

function trayIcon() {
  const size = 24;
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if ((x >= 9 && x <= 14 && y >= 3 && y <= 15) ||
        (y >= 11 && y <= 18 && ((x >= 5 && x <= 7) || (x >= 16 && x <= 18))) ||
        (y >= 18 && y <= 20 && x >= 7 && x <= 16) || (y >= 20 && x >= 11 && x <= 12)) {
      const i = (y * size + x) * 4;
      data[i] = 235; data[i + 1] = 180; data[i + 2] = 50; data[i + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(data, { width: size, height: size });
}

function keepWindowInTray(target) {
  target.on('minimize', () => target.hide());
  target.on('close', (event) => {
    if (!quitting) { event.preventDefault(); target.hide(); }
  });
}

async function launch() {
  if (!['win32', 'darwin'].includes(process.platform)) throw new Error('Windows and macOS only.');
  desktop = new DesktopInput({});
  diagnostics = new Diagnostics(path.join(app.getPath('userData'), 'logs'), (error) => {
    diagnosticsError = error.message;
    console.error(error.message);
    publish(status.phase, status.message);
  });
  startupStartedAt = Date.now();
  diagnostics.record('app-start', { version: app.getVersion() });
  if (process.platform === 'darwin') app.dock?.hide();
  powerMonitor.on('lock-screen', () => { if (active || pluginLoading) void abort('Recording stopped because the screen was locked.'); });
  powerMonitor.on('suspend', () => { if (active || pluginLoading) void abort('Recording stopped because the computer is suspending.'); });
  startupStage('preferences', 'begin');
  try {
    const saved = JSON.parse(await readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
    settings = preferences(saved);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      preferenceError = 'Settings could not be read. Review preferences and the cloud notice again.';
      status.message = preferenceError;
    }
  }
  startupStage('preferences', 'end');
  startupStage('login', 'begin');
  try { configureLogin(); }
  catch (error) { preferenceError = error.message; }
  startupStage('login', 'end');
  startupStage('plugins', 'begin');
  await initializePlugins();
  startupStage('plugins', 'end');
  startupStage('windows', 'begin');
  window = new BrowserWindow({
    width: 720, height: 800, minWidth: 580, minHeight: 640, show: false, skipTaskbar: false,
    backgroundColor: '#111827', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false,
      contextIsolation: true, sandbox: true, backgroundThrottling: false,
    },
  });
  const primary = screen.getPrimaryDisplay();
  const displays = screen.getAllDisplays().sort((a, b) => Number(b.id === primary.id) - Number(a.id === primary.id));
  const position = overlayPosition(settings.overlay, displays);
  overlay = new BrowserWindow({
    width: 224, height: 54, ...position, frame: false, focusable: false, alwaysOnTop: true,
    skipTaskbar: true, show: false, resizable: false, movable: true, transparent: true, acceptFirstMouse: true,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'overlay-preload.cjs'), contextIsolation: true,
      sandbox: true, backgroundThrottling: false },
  });
  overlayDrag = new OverlayDrag({
    window: overlay,
    cursor: () => screen.getCursorScreenPoint(),
    workArea: (point) => screen.getDisplayNearestPoint(point).workArea,
    persist: saveOverlayPosition,
  });
  overlay.on('move', () => {
    if (quitting) return;
    clearTimeout(overlayMoveTimer);
    overlayMoveTimer = undefined;
    if (overlayDrag.active) return;
    overlayMoveTimer = setTimeout(() => {
      overlayMoveTimer = undefined;
      if (overlay.isDestroyed()) return;
      const { x, y } = overlay.getBounds();
      void saveOverlayPosition({ x, y }).catch((error) => console.error(error.message));
    }, 250);
  });
  overlay.on('hide', () => {
    cancelOverlayInteraction();
  });
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(contents === window.webContents && contents.getURL() === uiUrl &&
      permission === 'media' && (Boolean(testingMic) || settings.consent && Boolean(active)) &&
      Array.isArray(details.mediaTypes) && details.mediaTypes.length > 0 &&
      details.mediaTypes.every((type) => type === 'audio'));
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission) =>
    contents === window.webContents && contents.getURL() === uiUrl &&
    permission === 'media' && (Boolean(testingMic) || settings.consent && Boolean(active)));
  for (const target of [window, overlay]) {
    target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    target.webContents.on('will-navigate', (event) => event.preventDefault());
  }
  window.webContents.on('render-process-gone', () => {
    testingMic = false;
    clearTimeout(micTestTimer);
    abort('Audio window stopped. Restart the app before dictating again.', true);
  });
  keepWindowInTray(window);
  window.on('hide', () => { if (testingMic) window.webContents.send('microphone-test-stop', testingMic); });
  installIpc();
  startupStage('windows', 'end');
  startupStage('renderers', 'begin');
  await Promise.all([window.loadURL(uiUrl), overlay.loadFile(path.join(__dirname, 'overlay.html'))]);
  startupStage('renderers', 'end');
  startupStage('desktop', 'begin');
  try { await desktop.warmup(); }
  catch (error) { preferenceError = error.message; }
  startupStage('desktop', 'end');
  startupStage('controls', 'begin');
  if (process.platform === 'win32') {
    overlayPointer = new OverlayPointer(overlay, observeOverlayPointer, (error) => {
      overlayControlError = error.message;
      cancelOverlayInteraction();
      console.error(`Native floating pointer interrupted (${error.code}).`);
      logEvent('error', active, { reason: `overlay-pointer-${error.code}`,
        pointerState: overlayPointer?.state, pointerPressed: overlayPointer?.pressed,
        pointerRestarts: overlayPointer?.restarts });
      publishOverlayPointer();
    });
  }
  tray = new Tray(trayIcon());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open VI', click: showSettings },
    { label: 'Stop dictation', click: () => { if (active) requestStop(active); } },
    { label: 'Cancel dictation', click: () => abort() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('double-click', showSettings);
  installShortcutPress();
  bindings = new ShortcutBindings(globalShortcut, () => {
    try { shortcutPress.down(shortcutKeys(settings.shortcut)); }
    catch (error) { publish('error', error.message); }
  }, () => { void abort(); });
  try {
    bindings.install([settings.shortcut, settings.cancelShortcut]);
    publish('idle', settings.consent ? 'Ready. Focus a text field and use the global shortcut.' : status.message);
  } catch (error) { publish('error', error.message); }
  startupStage('controls', 'end');
  if (!app.commandLine.hasSwitch('background') || bindings.current.length !== 2) await showSettings();
  startupComplete = true;
}

function installShortcutPress() {
  let pressedRun, pendingPress;
  shortcutPress = new ShortcutPress({
    held: (keys) => desktop.held(keys),
    press: () => {
      if (pendingPress) {
        if (settings.triggerMode === 'toggle') {
          if (pluginLoading) void abort();
          else if (active) requestStop(active);
        }
        return;
      }
      const press = { released: false };
      pendingPress = press;
      void begin(true).then((run) => {
        if (pendingPress !== press) return;
        pendingPress = undefined;
        if (!run || active !== run) return;
        pressedRun = run;
        if (press.released && settings.triggerMode === 'push-to-talk') requestStop(run);
      }).catch(() => {
        if (pendingPress === press) pendingPress = undefined;
        publish('error', 'Could not start dictation.', '');
      });
      pressedRun = active;
    },
    release: () => {
      if (pendingPress) pendingPress.released = true;
      if (settings.triggerMode === 'push-to-talk' && active && active === pressedRun) requestStop(active);
      pressedRun = undefined;
    },
    failure: (error) => {
      if (pendingPress) {
        pendingPress = undefined;
        if (settings.triggerMode === 'push-to-talk') { void abort(error.message, true, 'input'); return; }
      }
      if (settings.triggerMode === 'push-to-talk' && active && active === pressedRun) void abort(error.message, true, 'input');
      else { preferenceError = error.message; publish(status.phase, status.message); }
      pressedRun = undefined;
    },
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, args) => {
    if (!args.includes('--background')) showSettings();
  });
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    diagnostics.record('quit-start');
    const pendingMove = overlayMoveTimer !== undefined;
    clearTimeout(overlayMoveTimer);
    clearTimeout(micTestTimer);
    shortcutPress?.close();
    overlayPointer?.close();
    overlayMoveTimer = undefined;
    authProbe?.cancel();
    manualToken = undefined;
    globalShortcut.unregisterAll();
    const position = overlayDrag?.active ? overlayDrag.finish()
      : pendingMove && overlay && !overlay.isDestroyed() ? saveOverlayPosition(overlay.getBounds()) : Promise.resolve();
    const stopped = active || pluginLoading ? abort('Dictation stopped because the app is quitting.') : Promise.resolve();
    void Promise.allSettled([position, stopped, saveQueue, diagnostics.flush(),
      closePlugins(pluginRuntime).then(prunePluginCache)]).then((results) => {
      desktop?.close();
      if (results.some((result) => result.status === 'rejected')) {
        console.error('Some settings, plugin processes or diagnostic logs could not be closed cleanly.');
      }
      app.quit();
    });
  });
  app.on('window-all-closed', () => {});
  app.on('activate', showSettings);
  app.whenReady().then(launch).catch(() => {
    // Do not dump Electron/network objects that might hold an authenticated URL.
    console.error('VI could not start.');
    app.exit(1);
  });
}
