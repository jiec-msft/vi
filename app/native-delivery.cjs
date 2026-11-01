const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { NativeTrace } = require('./native-diagnostics.cjs');
let generation = 0;

class NativeDelivery {
  constructor(platform, resources, diagnostics) {
    this.trace = new NativeTrace(diagnostics, 'delivery', ++generation);
    const executable = platform === 'win32' ? 'powershell.exe' : path.join(resources, 'macos-delivery');
    const args = platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(resources, 'windows-delivery.ps1'), ...this.trace.arguments(process.pid)] : [];
    this.trace.emit('spawn', {}, true);
    try { this.process = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { this.trace.emit('failure', { fault: 'spawn' }, true); throw error; }
    this.trace.attach(this.process);
    this.trace.emit('spawned');
    this.sequence = 0;
    this.queue = Promise.resolve();
    this.process.once('error', () => this.fail('Desktop input helper could not start.'));
    this.process.once('exit', () => this.fail('Desktop input helper stopped. The transcript remains available for Copy.'));
    this.process.stdin.on('error', () => this.fail('Desktop input helper pipe closed.'));
    this.lines = readline.createInterface({ input: this.process.stdout, crlfDelay: Infinity });
    this.lines.on('line', (line) => {
      let fault = 'invalid-shape';
      try {
        if (line.length > 4096) { fault = 'oversize'; throw new Error(); }
        fault = 'invalid-json';
        const reply = JSON.parse(line);
        fault = !this.pending ? 'late-reply' : reply.id !== this.pending.id ? 'wrong-id' : 'invalid-shape';
        if (!this.pending || reply.id !== this.pending.id || typeof reply.ok !== 'boolean') throw new Error();
        const pending = this.pending;
        this.pending = undefined;
        clearTimeout(pending.timer);
        if (pending.action !== 'held' || !reply.ok || performance.now() - pending.started > 250) {
          this.trace.emit('reply', { action: pending.action, requestId: pending.id,
            spanMs: Math.round(performance.now() - pending.started), ...(reply.ok ? {} : { fault: 'native-error' }) });
        }
        if (reply.ok) pending.resolve(reply.value);
        else pending.reject(Object.assign(new Error({
          'target-changed': 'The original window is no longer focused. Use Copy result.',
          'window-order': 'Could not place the settings window behind the active app. Minimize settings and reopen it.',
          'secure-field': 'Password and secure fields cannot receive dictation.',
          'no-input': 'No editable text field is focused. Use Copy result.',
          'clipboard-changed': 'The clipboard changed while preparing delivery. Use Copy result.',
          'clipboard-unavailable': 'The clipboard is busy or contains a format that cannot be preserved. Use Copy result.',
          'modifiers-held': 'Release keyboard modifiers and mouse buttons before pasting. Use Copy result.',
          'composition-active': 'Finish the input-method candidate selection, then use Copy result.',
          'paste-unconfirmed': 'The target did not read the transcript. Review the field before pasting manually.',
          'restore-failed': 'Paste was requested, but the previous clipboard could not be restored. Review the field before retrying.',
          'permission': 'Allow Accessibility access for VI in macOS System Settings.',
        }[reply.code] || 'Desktop delivery failed. Review the target before using Copy result.'),
        { code: reply.code || 'native-error',
          check: ['foreground-window', 'foreground-process', 'accessible-focus', 'native-focus'].includes(reply.check)
            ? reply.check : undefined }));
      } catch {
        this.trace.emit('failure', { fault }, true);
        this.fail('Desktop input helper returned an invalid response.');
      }
    });
  }

  request(action, data = {}) {
    const queued = performance.now();
    const work = () => {
      if (this.closed) throw new Error('Desktop input helper is closed.');
      const id = ++this.sequence;
      const started = performance.now();
      if (action !== 'held') this.trace.emit('request', { action, requestId: id,
        spanMs: Math.round(started - queued) }, true);
      return new Promise((resolve, reject) => {
        const initialization = action === 'ready';
        const timer = setTimeout(() => {
          this.trace.emit('timeout', { action, requestId: id, fault: 'timeout',
            spanMs: Math.round(performance.now() - started) }, true);
          this.fail(initialization ? 'Desktop input helper initialization timed out.'
            : 'Desktop input timed out. The clipboard may contain the transcript; review the target before using Copy result.');
        },
        initialization ? 20000 : 8000);
        this.pending = { id, action, started, resolve, reject, timer };
        this.process.stdin.write(`${JSON.stringify({ id, action, ...data })}\n`, (error) => {
          if (action !== 'held' || error) this.trace.emit(error ? 'failure' : 'write', { action, requestId: id,
            ...(error ? { fault: 'pipe' } : {}) });
        });
      });
    };
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => {});
    return result;
  }

  fail(message) {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error(message));
      this.pending = undefined;
    }
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.trace.closing = true;
    this.trace.emit('close', {}, true);
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('Desktop input helper was closed.'));
      this.pending = undefined;
    }
    this.lines.close();
    this.process.stdin.end();
    this.process.kill();
  }
}

module.exports = { NativeDelivery };
