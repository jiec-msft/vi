const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { NativeTrace } = require('./native-diagnostics.cjs');

class OverlayPointer {
  constructor(window, onEvent, onFailure, spawnProcess = spawn, diagnostics) {
    this.diagnostics = diagnostics;
    this.onEvent = onEvent;
    this.onFailure = onFailure;
    this.spawnProcess = spawnProcess;
    this.ready = false;
    this.pressed = false;
    this.state = 'starting';
    this.suspendedAt = undefined;
    this.heartbeatCount = 0;
    this.maxHeartbeatGapMs = 0;
    this.restarts = 0;
    const handle = window.getNativeWindowHandle();
    this.id = handle.length === 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
    this.start();
  }

  start() {
    if (this.closed) return;
    this.state = 'starting';
    this.suspendedAt = undefined;
    this.heartbeatCount = 0;
    this.maxHeartbeatGapMs = 0;
    this.trace = new NativeTrace(this.diagnostics, 'pointer', this.restarts + 1);
    this.trace.emit('spawn', {}, true);
    let child;
    try {
      child = this.spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, '..', 'native', 'windows-overlay.ps1').replace('app.asar', 'app.asar.unpacked'),
      '-Window', this.id, '-Parent', String(process.pid), ...this.trace.arguments(process.pid)],
      { windowsHide: true, stdio: [this.diagnostics ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    } catch {
      this.failed = false;
      this.ended = true;
      this.fail('spawn');
      return;
    }
    this.process = child;
    this.trace.attach(child);
    this.trace.emit('spawned');
    this.failed = false;
    this.ended = false;
    this.timer = setTimeout(() => this.fail('timeout'), 8000);
    clearInterval(this.pulseTimer);
    if (this.diagnostics && child.stdin) {
      const pulse = () => { if (!this.closed && this.process === child && !child.stdin.destroyed) child.stdin.write('pulse\n'); };
      child.stdin.on('error', () => { if (!this.closed && this.process === child) this.fail('stream'); });
      pulse();
      this.pulseTimer = setInterval(pulse, 2000);
      this.pulseTimer.unref?.();
    }
    const ended = () => {
      if (this.process !== child || this.closed || this.ended) return;
      this.ended = true;
      clearTimeout(this.reapTimer);
      if (!this.failed) this.fail('exit');
      else this.scheduleRestart();
    };
    child.once('error', () => {
      if (this.process === child && !this.closed) this.fail('spawn');
    });
    child.once('exit', ended);
    child.once('close', ended);
    this.lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on('close', () => {
      if (this.process === child && !this.closed && !this.failed) this.fail('stream');
    });
    this.lines.on('line', (line) => {
      if (this.process !== child || this.closed || this.failed) return;
      let event;
      try {
        if (line.length > 256) throw new Error();
        event = JSON.parse(line);
        if (event.type === 'ready' && !this.ready && !this.pressed) {
          this.trace.emit(this.state === 'suspended' ? 'resumed' : 'ready', {
            spanMs: this.suspendedAt === undefined ? 0 : Math.round(performance.now() - this.suspendedAt),
            count: this.heartbeatCount || 0, maxHeartbeatGapMs: this.maxHeartbeatGapMs });
          this.ready = true;
          this.state = 'ready';
          clearTimeout(this.timer);
        } else if (event.type === 'suspended' && this.state !== 'suspended' && !this.pressed) {
          this.suspendedAt = performance.now();
          this.lastHeartbeatAt = this.suspendedAt;
          this.maxHeartbeatGapMs = 0;
          this.heartbeatCount = 0;
          this.trace.emit('suspended');
          this.ready = false;
          this.state = 'suspended';
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.fail('timeout'), 8000);
        } else if (event.type === 'heartbeat' && this.state === 'suspended' && !this.pressed) {
          this.heartbeatCount++;
          const at = performance.now();
          this.maxHeartbeatGapMs = Math.max(this.maxHeartbeatGapMs, Math.round(at - this.lastHeartbeatAt));
          this.lastHeartbeatAt = at;
          if (this.heartbeatCount % 30 === 0) this.trace.emit('suspended', { count: this.heartbeatCount,
            spanMs: Math.round(performance.now() - this.suspendedAt), maxHeartbeatGapMs: this.maxHeartbeatGapMs });
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.fail('timeout'), 8000);
          return;
        } else if (event.type === 'cancel' && this.pressed) {
          this.pressed = false;
        } else {
          if (!this.ready || !['down', 'move', 'up'].includes(event.type) ||
              !Number.isInteger(event.x) || !Number.isInteger(event.y) ||
              Math.abs(event.x) > 1000000 || Math.abs(event.y) > 1000000) throw new Error();
          if (event.type === 'down') {
            if (this.pressed) throw new Error();
            this.pressed = true;
          }
          else if (!this.pressed) throw new Error();
          if (event.type === 'up') this.pressed = false;
        }
      } catch { this.fail('protocol'); return; }
      try { this.onEvent(event); }
      catch { this.fail('dispatch'); }
    });
  }

  fail(reason) {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.trace.emit('failure', { fault: reason, pointerRestarts: this.restarts, pointerState: this.state }, true);
    clearInterval(this.pulseTimer);
    this.ready = false;
    const pressed = this.pressed;
    this.pressed = false;
    this.state = this.restarts < 3 ? 'recovering' : 'unavailable';
    clearTimeout(this.timer);
    this.lines?.close();
    if (!this.ended) {
      this.reapTimer = setTimeout(() => {
        if (this.closed || this.ended) return;
        this.state = 'unavailable';
        this.notifyFailure('termination');
      }, 2000);
      this.process.kill();
    }
    if (pressed) this.onEvent({ type: 'cancel' });
    this.notifyFailure(reason);
    if (this.ended) this.scheduleRestart();
  }

  notifyFailure(reason) {
    const error = new Error(this.state === 'unavailable'
      ? 'Native floating mouse controls unavailable. Use mouse fallback, the record/stop shortcut or tray menu. Restart the app to retry.'
      : 'Native floating mouse controls interrupted. Mouse fallback and shortcuts are available while recovery is attempted.');
    error.code = reason;
    this.onFailure(error);
  }

  scheduleRestart() {
    if (this.closed || this.state === 'unavailable' || this.retryTimer !== undefined) return;
    const delay = [250, 1000, 3000][this.restarts++];
    this.trace.emit('restart', { pointerRestarts: this.restarts });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.start();
    }, delay);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.trace.closing = true;
    this.trace.emit('close', {}, true);
    clearInterval(this.pulseTimer);
    this.ready = false;
    this.state = 'closed';
    this.pressed = false;
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.reapTimer);
    this.lines?.close();
    if (!this.ended) this.process?.kill();
  }
}

module.exports = { OverlayPointer };
