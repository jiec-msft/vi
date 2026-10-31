const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');

class NativeDelivery {
  constructor(platform, resources) {
    const executable = platform === 'win32' ? 'powershell.exe' : path.join(resources, 'macos-delivery');
    const args = platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(resources, 'windows-delivery.ps1')] : [];
    this.process = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.sequence = 0;
    this.queue = Promise.resolve();
    this.process.stderr.resume();
    this.process.once('error', () => this.fail('Desktop input helper could not start.'));
    this.process.once('exit', () => this.fail('Desktop input helper stopped. The transcript remains available for Copy.'));
    this.process.stdin.on('error', () => this.fail('Desktop input helper pipe closed.'));
    this.lines = readline.createInterface({ input: this.process.stdout, crlfDelay: Infinity });
    this.lines.on('line', (line) => {
      try {
        if (line.length > 4096) throw new Error();
        const reply = JSON.parse(line);
        if (!this.pending || reply.id !== this.pending.id || typeof reply.ok !== 'boolean') throw new Error();
        const pending = this.pending;
        this.pending = undefined;
        clearTimeout(pending.timer);
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
        this.fail('Desktop input helper returned an invalid response.');
      }
    });
  }

  request(action, data = {}) {
    const work = () => {
      if (this.closed) throw new Error('Desktop input helper is closed.');
      const id = ++this.sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => this.fail('Desktop input timed out. The clipboard may contain the transcript; review the target before using Copy result.'), 8000);
        this.pending = { id, resolve, reject, timer };
        this.process.stdin.write(`${JSON.stringify({ id, action, ...data })}\n`);
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
