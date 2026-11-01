const { mkdir, stat, rename, rm, appendFile } = require('node:fs/promises');
const path = require('node:path');

const events = new Set(['app-start', 'turn-start', 'capture-ready', 'cloud-ready', 'input-paused', 'input-resumed',
  'input-target', 'input-ready', 'input-fallback', 'input-skipped', 'input-error', 'segment-final',
  'overlay-down', 'drag-start', 'drag-end', 'stop', 'capture-ended', 'done', 'error', 'cancel',
  'input-focus-return', 'window-shown', 'quit-start', 'plugin-call', 'plugin-warning', 'startup-stage']);
const reasons = new Set(['user', 'limit', 'microphone', 'cloud', 'input', 'cancel', 'unknown',
  'target-changed', 'native-error', 'foreground-changed', 'native-focus-changed', 'field-changed',
  'owned-text-changed', 'caret-changed', 'user-input-active', 'composition-active', 'paste-unconfirmed',
  'transcript-changed', 'no-speech', 'unsupported', 'app-focused', 'no-target', 'cancelled']);
for (const reason of ['secure-field', 'no-input', 'modifiers-held', 'clipboard-changed', 'clipboard-unavailable',
  'restore-failed', 'permission', 'clipboard-copy', 'window-order', 'plugin']) reasons.add(reason);
for (const fault of ['spawn', 'exit', 'timeout', 'stream', 'protocol', 'dispatch', 'termination']) {
  reasons.add(`overlay-pointer-${fault}`);
}
const startupStages = new Set(['preferences', 'login', 'plugins', 'windows', 'renderers', 'desktop',
  'controls', 'window-show', 'window-focus', 'window-order']);

class Diagnostics {
  constructor(directory, onFailure, maxBytes = 262144) {
    this.directory = directory;
    this.file = path.join(directory, 'events.jsonl');
    this.onFailure = onFailure;
    this.maxBytes = maxBytes;
    this.queue = Promise.resolve();
  }

  record(event, data = {}) {
    if (this.failed) return;
    if (!events.has(event)) throw new Error('Invalid diagnostic event.');
    const entry = { time: new Date().toISOString(), event };
    if (/^[a-f0-9-]{36}$/.test(data.turn || '')) entry.turn = data.turn;
    if (reasons.has(data.reason)) entry.reason = data.reason;
    for (const key of ['ownAppFocused', 'mainWindowVisible', 'placedBehind']) {
      if (typeof data[key] === 'boolean') entry[key] = data[key];
    }
    if (['foreground-window', 'foreground-process', 'accessible-focus', 'native-focus'].includes(data.check)) entry.check = data.check;
    if (['target', 'document', 'selection', 'owned-range', 'plan', 'type', 'confirm', 'request'].includes(data.stage)) entry.stage = data.stage;
    if (event === 'startup-stage' && startupStages.has(data.stage)) {
      entry.stage = data.stage;
      if (['begin', 'end'].includes(data.state)) entry.state = data.state;
    }
    if (['starting', 'ready', 'suspended', 'recovering', 'unavailable', 'closed'].includes(data.pointerState)) {
      entry.pointerState = data.pointerState;
    }
    if (typeof data.pointerPressed === 'boolean') entry.pointerPressed = data.pointerPressed;
    if (['edit-message-failed', 'focus-unavailable', 'foreground-unavailable', 'unicode-blocked', 'ime-state', 'provider-error'].includes(data.nativeFault)) {
      entry.nativeFault = data.nativeFault;
    }
    if (['shortcut', 'preview'].includes(data.origin)) entry.origin = data.origin;
    if (['streaming', 'final', 'preview', 'pending'].includes(data.mode)) entry.mode = data.mode;
    if (['requested', 'inserted', 'preview', 'paused', 'suppressed'].includes(data.outcome)) entry.outcome = data.outcome;
    if (['no-focused-element', 'no-text-pattern', 'selection-count', 'selection-limit', 'document-limit',
      'value-prefix', 'value-selection'].includes(data.readiness)) entry.readiness = data.readiness;
    if (['document-mismatch', 'range-mismatch'].includes(data.confirmation)) entry.confirmation = data.confirmation;
    if (typeof data.version === 'string' && data.version.length <= 100 &&
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(data.version)) {
      entry.version = data.version;
    }
    if (typeof data.pluginId === 'string' && data.pluginId.length <= 100 && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(data.pluginId)) {
      entry.pluginId = data.pluginId;
    }
    if (['preview.transform', 'final.transform', 'output.guard', 'load', 'init', 'close'].includes(data.hook)) entry.hook = data.hook;
    for (const key of ['pluginError', 'pluginCause']) {
      if (['timeout', 'cancelled', 'process-exit', 'plugin-error', 'invalid-result', 'invalid-text',
        'invalid-reply', 'start-failed', 'send-failed', 'instance-closed', 'concurrent-call', 'process-error',
        'termination-failed', 'package-changed', 'invalid-config', 'trust-required', 'load-failed',
        'discovery-failed', 'initialization-failed', 'cache-cleanup-failed'].includes(data[key])) entry[key] = data[key];
    }
    for (const key of ['elapsedMs', 'audioBytes', 'queuedBytes', 'revisions', 'expectedChars', 'actualChars',
      'selectionCount', 'initialChars', 'prefixChars', 'suffixChars', 'expectedDocumentChars', 'expectedVariants',
      'writes', 'transcriptChars', 'segments', 'segment', 'segmentAudioBytes', 'nativeLine', 'skippedSegments', 'count',
      'pointerRestarts']) {
      if (Number.isSafeInteger(data[key]) && data[key] >= 0) entry[key] = data[key];
    }
    this.queue = this.queue.then(async () => {
      if (this.failed) return;
      await mkdir(this.directory, { recursive: true });
      let size = 0;
      try { size = (await stat(this.file)).size; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const line = `${JSON.stringify(entry)}\n`;
      if (size + Buffer.byteLength(line) > this.maxBytes) {
        await rm(`${this.file}.1`, { force: true });
        await rename(this.file, `${this.file}.1`);
      }
      await appendFile(this.file, line, { mode: 0o600 });
    }).catch(() => {
      this.failed = true;
      this.onFailure(new Error('Diagnostic status log could not be saved.'));
    });
  }

  flush() { return this.queue; }
}

module.exports = { Diagnostics };
