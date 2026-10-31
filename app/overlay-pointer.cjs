const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');

class OverlayPointer {
  constructor(window, onEvent, onFailure, spawnProcess = spawn) {
    this.onEvent = onEvent;
    this.onFailure = onFailure;
    const handle = window.getNativeWindowHandle();
    const id = handle.length === 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
    this.process = spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, '..', 'native', 'windows-overlay.ps1').replace('app.asar', 'app.asar.unpacked'),
      '-Window', id, '-Parent', String(process.pid)],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.timer = setTimeout(() => this.fail(), 8000);
    this.process.stderr.resume();
    this.process.once('error', () => this.fail());
    this.process.once('exit', () => this.fail());
    this.lines = readline.createInterface({ input: this.process.stdout, crlfDelay: Infinity });
    this.lines.on('line', (line) => {
      try {
        if (line.length > 256) throw new Error();
        const event = JSON.parse(line);
        if (event.type === 'ready' && !this.ready) {
          this.ready = true;
          clearTimeout(this.timer);
        } else {
          if (!this.ready || !['down', 'move', 'up'].includes(event.type) ||
              !Number.isInteger(event.x) || !Number.isInteger(event.y) ||
              Math.abs(event.x) > 1000000 || Math.abs(event.y) > 1000000) throw new Error();
          if (event.type === 'down') this.pressed = true;
          else if (!this.pressed) throw new Error();
          if (event.type === 'up') this.pressed = false;
        }
        this.onEvent(event);
      } catch { this.fail(); }
    });
  }

  fail() {
    if (this.closed) return;
    this.close();
    this.onFailure(new Error('Floating mouse controls unavailable. Use the record/stop shortcut or tray menu.'));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.pressed = false;
    clearTimeout(this.timer);
    this.lines?.close();
    this.process.kill();
  }
}

module.exports = { OverlayPointer };
