const fs = require('node:fs');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');

const control = new Int32Array(workerData.control);
const file = path.join(workerData.directory, 'events.jsonl');
let fd, size, failed = false;
function failure() {
  if (failed) return;
  failed = true;
  Atomics.store(control, 2, 1);
  Atomics.notify(control, 0);
  parentPort.postMessage({ failed: true });
  if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* Preserve the first failure. */ } }
  fd = undefined;
}
function rotate() {
  fs.closeSync(fd);
  fd = undefined;
  fs.rmSync(`${file}.3`, { force: true });
  for (let index = 2; index >= 1; index--) {
    if (fs.existsSync(`${file}.${index}`)) fs.renameSync(`${file}.${index}`, `${file}.${index + 1}`);
  }
  if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
  fd = fs.openSync(file, 'a', 0o600);
  size = 0;
}
try {
  fs.mkdirSync(workerData.directory, { recursive: true, mode: 0o700 });
  size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  fd = fs.openSync(file, 'a', 0o600);
} catch { failure(); }

parentPort.on('message', ({ lines, seq, close }) => {
  if (close) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { failure(); } }
    fd = undefined;
    parentPort.close();
    return;
  }
  if (failed) return;
  try {
    for (const line of lines) {
      const bytes = Buffer.from(line);
      if (bytes.length > workerData.maxBytes) throw new Error('Oversized diagnostic record.');
      if (size + bytes.length > workerData.maxBytes) rotate();
      let offset = 0;
      while (offset < bytes.length) {
        const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
        if (written < 1) throw new Error('Diagnostic write did not advance.');
        offset += written;
      }
      size += bytes.length;
    }
    Atomics.store(control, 0, seq);
    Atomics.notify(control, 0);
    parentPort.postMessage({ seq });
  } catch { failure(); }
});
