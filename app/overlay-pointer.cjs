const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');

class OverlayPointer {
  constructor(window, onEvent, onFailure, spawnProcess = spawn) {
    this.onEvent = onEvent;
    this.onFailure = onFailure;
    this.spawnProcess = spawnProcess;
    this.ready = false;
    this.pressed = false;
    this.state = 'starting';
    this.restarts = 0;
    const handle = window.getNativeWindowHandle();
    this.id = handle.length === 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
    this.start();
  }

  start() {
    if (this.closed) return;
    this.state = 'starting';
    let child;
    try {
      child = this.spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, '..', 'native', 'windows-overlay.ps1').replace('app.asar', 'app.asar.unpacked'),
      '-Window', this.id, '-Parent', String(process.pid)],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      this.failed = false;
      this.ended = true;
      this.fail('spawn');
      return;
    }
    this.process = child;
    this.failed = false;
    this.ended = false;
    this.timer = setTimeout(() => this.fail('timeout'), 8000);
    child.stderr.resume();
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
          this.ready = true;
          this.state = 'ready';
          clearTimeout(this.timer);
        } else if (event.type === 'suspended' && this.state !== 'suspended' && !this.pressed) {
          this.ready = false;
          this.state = 'suspended';
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.fail('timeout'), 8000);
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
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.start();
    }, delay);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
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
