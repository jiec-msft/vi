const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { Worker } = require('node:worker_threads');

const events = new Set(['app-start', 'turn-start', 'capture-ready', 'cloud-ready', 'input-paused', 'input-resumed',
  'input-target', 'input-ready', 'input-fallback', 'input-skipped', 'input-error', 'segment-final',
  'overlay-down', 'drag-start', 'drag-end', 'stop', 'capture-ended', 'done', 'error', 'cancel',
  'input-focus-return', 'window-shown', 'quit-start', 'plugin-call', 'plugin-warning', 'startup-stage',
  'lifecycle', 'native', 'event-loop', 'diagnostic-drop']);
const reasons = new Set(['user', 'limit', 'microphone', 'cloud', 'provider', 'input', 'cancel', 'unknown',
  'target-changed', 'native-error', 'foreground-changed', 'native-focus-changed', 'field-changed',
  'owned-text-changed', 'caret-changed', 'user-input-active', 'composition-active', 'paste-unconfirmed',
  'transcript-changed', 'no-speech', 'unsupported', 'app-focused', 'no-target', 'cancelled']);
for (const reason of ['secure-field', 'no-input', 'modifiers-held', 'clipboard-changed', 'clipboard-unavailable',
  'restore-failed', 'permission', 'clipboard-copy', 'window-order', 'plugin']) reasons.add(reason);
for (const fault of ['spawn', 'exit', 'timeout', 'stream', 'protocol', 'dispatch', 'termination']) {
  reasons.add(`overlay-pointer-${fault}`);
}
const startupStages = new Set(['preferences', 'login', 'plugins', 'windows', 'renderers', 'desktop',
  'controls', 'window-show', 'window-focus', 'window-order', 'build-info', 'pointer', 'tray', 'shortcuts',
  'settings-renderer', 'overlay-renderer', 'quit']);
const components = new Set(['main', 'settings', 'overlay', 'delivery', 'pointer', 'gpu', 'utility', 'network']);
const states = new Set(['begin', 'end', 'failure', 'spawn', 'spawned', 'request', 'write', 'reply', 'timeout',
  'ready', 'suspended', 'resumed', 'restart', 'close', 'exit', 'visible', 'unresponsive', 'responding',
  'load-failed', 'process-gone', 'startup-failed', 'uncaught-exception', 'unhandled-rejection', 'quit-complete',
  'stderr', 'native-start', 'compile', 'call', 'host-gap', 'host-resumed', 'context', 'log-write-failed']);
for (const state of ['boot', 'app-ready', 'lock', 'unlock', 'suspend', 'resume', 'metadata']) states.add(state);
const actions = new Set(['ready', 'capture', 'held', 'paste', 'settle-window']);
const faults = new Set(['spawn', 'exit', 'timeout', 'stream', 'protocol', 'dispatch', 'termination', 'pipe',
  'compilation', 'assembly-load', 'access-denied', 'powershell-error', 'unknown', 'invalid-settings',
  'shortcut-conflict', 'load-failed', 'native-error', 'log-write-failed', 'startup-failed',
  'clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure',
  'memory-eviction', 'unhandled-rejection', 'uncaught-exception']);
for (const fault of ['owned-close', 'invalid-json', 'wrong-id', 'invalid-shape', 'oversize', 'late-reply']) faults.add(fault);

function safeError(error) {
  const result = {};
  if (['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'AggregateError', 'SystemError'].includes(error?.name)) {
    result.errorClass = error.name;
  }
  if (['ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOSPC', 'EMFILE', 'EPIPE', 'ECONNRESET', 'ETIMEDOUT',
    'ERR_UNHANDLED_REJECTION', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE',
    'ERR_PROVIDER_SETUP'].includes(error?.code)) result.errorCode = error.code;
  return result;
}

class Diagnostics {
  constructor(directory, onFailure, maxBytes = 524288, options = {}) {
    this.directory = directory;
    this.file = path.join(directory, 'events.jsonl');
    this.onFailure = onFailure;
    this.maxBytes = maxBytes;
    this.runId = options.runId || randomUUID();
    this.pid = options.pid || process.pid;
    this.clock = options.clock || (() => performance.now());
    this.wall = options.wall || (() => new Date());
    this.started = this.clock();
    this.sequence = 0;
    this.sentSequence = 0;
    this.pending = [];
    this.pendingBytes = 0;
    this.dropped = 0;
    this.stages = new Map();
    this.common = {};
    this.inflight = new Map();
    this.control = new Int32Array(new SharedArrayBuffer(16));
    try {
      const createWriter = options.createWriter || ((data) => new Worker(path.join(__dirname, 'diagnostics-writer.cjs'), { workerData: data }));
      this.writer = createWriter({ directory, maxBytes, control: this.control.buffer });
      this.writer.unref();
      this.writer.on('message', (message) => {
        if (message.failed) this.fail();
        this.reap();
      });
      this.writer.on('error', () => this.fail());
      this.writer.on('exit', () => { if (!this.closed && !this.failed) this.fail(); });
      this.writer.unref();
    } catch { this.fail(); }
  }

  now() { return Math.max(0, Math.round(this.clock() - this.started)); }

  metadata(data) {
    this.common.buildInfoState = 'unavailable';
    for (const key of ['version', 'electronVersion', 'chromeVersion', 'nodeVersion', 'osVersion']) {
      if (typeof data[key] === 'string' && data[key].length <= 100 &&
          /^\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(data[key])) {
        this.common[key] = data[key];
      }
    }
    for (const key of ['frameworkRevision', 'assemblyRevision']) {
      if (/^[a-f0-9]{40}$/.test(data[key] || '')) this.common[key] = data[key];
    }
    if (this.common.frameworkRevision && this.common.assemblyRevision) this.common.buildInfoState = 'available';
    if (['win32', 'darwin', 'linux'].includes(data.platform)) this.common.platform = data.platform;
    if (['x64', 'arm64', 'ia32'].includes(data.arch)) this.common.arch = data.arch;
  }

  entry(event, data) {
    if (!events.has(event)) throw new Error('Invalid diagnostic event.');
    const entry = { ...this.common, time: this.wall().toISOString(), monoMs: this.now(), clock: 'main-performance', event,
      run: this.runId, pid: this.pid, seq: ++this.sequence };
    if (this.lastStage) entry.lastStage = this.lastStage;
    if (this.lastSuccessfulStage) entry.lastSuccessfulStage = this.lastSuccessfulStage;
    if (this.stages.size) entry.activeStages = [...this.stages.keys()].slice(0, 16);
    if (/^[a-f0-9-]{36}$/.test(data.turn || '')) entry.turn = data.turn;
    if (reasons.has(data.reason)) entry.reason = data.reason;
    for (const key of ['ownAppFocused', 'mainWindowVisible', 'placedBehind', 'mainFrame']) {
      if (typeof data[key] === 'boolean') entry[key] = data[key];
    }
    if (['foreground-window', 'foreground-process', 'accessible-focus', 'native-focus'].includes(data.check)) entry.check = data.check;
    if (['target', 'document', 'selection', 'owned-range', 'plan', 'type', 'confirm', 'request'].includes(data.stage)) entry.stage = data.stage;
    if (event === 'startup-stage' && startupStages.has(data.stage)) {
      entry.stage = data.stage;
      if (['begin', 'end', 'failure'].includes(data.state)) entry.state = data.state;
    }
    if (['native', 'lifecycle'].includes(event) && states.has(data.state)) entry.state = data.state;
    if (components.has(data.component)) entry.component = data.component;
    if (actions.has(data.action)) entry.action = data.action;
    if (faults.has(data.fault)) entry.fault = data.fault;
    if (['SetWindowPos', 'GetCursorPos', 'GetForegroundWindow', 'GetGUIThreadInfo', 'SendInput',
      'OpenClipboard', 'UIAutomation', 'compile', 'host-pulse'].includes(data.api)) entry.api = data.api;
    if (['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'AggregateError', 'SystemError'].includes(data.errorClass)) entry.errorClass = data.errorClass;
    if (safeError({ code: data.errorCode }).errorCode) entry.errorCode = data.errorCode;
    for (const key of ['inputDesktop', 'threadDesktop']) {
      if (['Default', 'Winlogon', 'other', 'unavailable'].includes(data[key])) entry[key] = data[key];
    }
    if (['WinSta0', 'other', 'unavailable'].includes(data.station)) entry.station = data.station;
    if (/^\d{15,20}$/.test(data.birthFileTime || '')) entry.birthFileTime = data.birthFileTime;
    if (typeof data.nativeTime === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,7}Z$/.test(data.nativeTime)) entry.nativeTime = data.nativeTime;
    if (Number.isInteger(data.exitCode) && data.exitCode >= -2147483648 && data.exitCode <= 4294967295) entry.exitCode = data.exitCode;
    if (Number.isInteger(data.errorNumber) && data.errorNumber >= -2147483648 && data.errorNumber <= 2147483647) entry.errorNumber = data.errorNumber;
    if (['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGILL', 'SIGBUS', 'SIGTRAP'].includes(data.signal)) entry.signal = data.signal;
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
      'pointerRestarts', 'generation', 'helperPid', 'parentPid', 'requestId', 'spanMs', 'nativeMonoMs',
      'stderrBytes', 'hostGapMs', 'win32Error', 'sessionId', 'wtsState', 'dropped', 'delayMaxMs', 'delayMeanMs',
      'maxHeartbeatGapMs']) {
      if (Number.isSafeInteger(data[key]) && data[key] >= 0) entry[key] = data[key];
    }
    return entry;
  }

  record(event, data = {}) {
    if (this.failed || this.closed) return;
    this.reap();
    const line = `${JSON.stringify(this.entry(event, data))}\n`;
    if (Buffer.byteLength(line) > 4096 || this.pending.length + this.inflight.size >= 120 ||
        this.pendingBytes + this.inflightBytes + Buffer.byteLength(line) > 24576) {
      this.dropped++;
      return;
    }
    this.pending.push(line);
    this.pendingBytes += Buffer.byteLength(line);
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; this.drain(); }, 1000);
      this.timer.unref?.();
    }
  }

  checkpoint(event, data = {}) {
    if (this.failed || this.closed) return;
    this.drain();
    this.reap();
    const line = `${JSON.stringify(this.entry(event, data))}\n`;
    if (Buffer.byteLength(line) > 4096) { this.fail(); return; }
    if (this.inflight.size + this.pending.length >= 128 ||
        this.inflightBytes + this.pendingBytes + Buffer.byteLength(line) > 32768) { this.dropped++; return; }
    this.pending.push(line);
    this.pendingBytes += Buffer.byteLength(line);
    this.drain();
    const ack = Atomics.load(this.control, 0);
    if (ack < this.sentSequence) Atomics.wait(this.control, 0, ack, 25);
    if (Atomics.load(this.control, 2)) this.fail();
  }

  stage(stage, state, error) {
    if (!startupStages.has(stage)) throw new Error('Invalid diagnostic stage.');
    const at = this.now();
    let spanMs;
    if (state === 'begin') {
      this.stages.set(stage, at);
      this.lastStage = stage;
    } else {
      const start = this.stages.get(stage);
      if (start !== undefined) spanMs = Math.max(0, at - start);
      this.stages.delete(stage);
      if (state === 'end') this.lastSuccessfulStage = stage;
    }
    this.checkpoint('startup-stage', { stage, state, spanMs, elapsedMs: at, ...safeError(error) });
  }

  drain() {
    if (this.failed || this.closed) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.dropped) {
      this.reap();
      const line = `${JSON.stringify(this.entry('diagnostic-drop', { dropped: this.dropped }))}\n`;
      if (this.inflight.size + this.pending.length < 127 &&
          this.inflightBytes + this.pendingBytes + Buffer.byteLength(line) <= 28672) {
        this.pending.push(line);
        this.pendingBytes += Buffer.byteLength(line);
        this.dropped = 0;
      }
    }
    const lines = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    if (!lines.length) return;
    try {
      for (const line of lines) {
        const sequence = JSON.parse(line).seq;
        this.inflight.set(sequence, Buffer.byteLength(line));
      }
      this.sentSequence = JSON.parse(lines.at(-1)).seq;
      this.writer.postMessage({ lines, seq: this.sentSequence });
    } catch { this.fail(); }
  }

  reap() {
    const ack = Atomics.load(this.control, 0);
    for (const sequence of this.inflight.keys()) if (sequence <= ack) this.inflight.delete(sequence);
    this.inflightBytes = [...this.inflight.values()].reduce((sum, bytes) => sum + bytes, 0);
  }

  fail() {
    if (this.failed) return;
    this.failed = true;
    clearTimeout(this.timer);
    this.pending = [];
    this.pendingBytes = 0;
    try { this.onFailure(new Error('Diagnostic status log could not be saved.')); }
    catch { console.error('Diagnostic failure notification could not be delivered.'); }
  }

  watchProcess(target = process) {
    this.fatalMonitor = (error, origin) => this.checkpoint('lifecycle', {
      component: 'main', state: origin === 'unhandledRejection' ? 'unhandled-rejection' : 'uncaught-exception',
      ...safeError(error),
    });
    target.on('uncaughtExceptionMonitor', this.fatalMonitor);
    this.processTarget = target;
    this.delay = monitorEventLoopDelay({ resolution: 20 });
    this.delay.enable();
    this.delayTimer = setInterval(() => {
      if (this.delay.max >= 1000000000) this.record('event-loop', {
        delayMaxMs: Math.round(this.delay.max / 1000000), delayMeanMs: Math.round(this.delay.mean / 1000000),
      });
      this.delay.reset();
    }, 5000);
    this.delayTimer.unref?.();
  }

  async flush() {
    this.drain();
    const deadline = performance.now() + 200;
    while (!this.failed && Atomics.load(this.control, 0) < this.sentSequence && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!this.failed && Atomics.load(this.control, 0) < this.sentSequence && !this.delayed) {
      this.delayed = true;
      try { this.onFailure(new Error('Diagnostic log flushing is delayed; some records may arrive late.')); }
      catch { console.error('Diagnostic failure notification could not be delivered.'); }
    }
  }

  close() {
    this.drain();
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.delayTimer);
    this.delay?.disable();
    if (this.fatalMonitor) this.processTarget.removeListener('uncaughtExceptionMonitor', this.fatalMonitor);
    this.writer?.postMessage({ close: true });
    this.writer?.unref();
  }
}

module.exports = { Diagnostics, safeError };
