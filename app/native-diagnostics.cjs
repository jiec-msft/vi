const { performance } = require('node:perf_hooks');
const { safeError } = require('./diagnostics.cjs');

class NativeTrace {
  constructor(diagnostics, component, generation) {
    this.diagnostics = diagnostics;
    this.component = component;
    this.generation = generation;
    this.started = performance.now();
    this.tail = '';
    this.stderrBytes = 0;
    this.stderrClasses = new Set();
  }

  emit(state, data = {}, critical = false) {
    const method = critical ? 'checkpoint' : 'record';
    this.diagnostics?.[method]('native', { component: this.component, generation: this.generation,
      helperPid: this.child?.pid, state, spanMs: Math.round(performance.now() - this.started), ...data });
  }

  arguments(parentPid) {
    if (!this.diagnostics || this.diagnostics.failed) return [];
    return ['-DiagnosticsDirectory', this.diagnostics.directory, '-DiagnosticRun', this.diagnostics.runId,
      '-DiagnosticGeneration', String(this.generation), '-DiagnosticParent', String(parentPid)];
  }

  attach(child) {
    this.child = child;
    child.stderr.on('data', (bytes) => {
      this.stderrBytes += bytes.length;
      const text = this.tail + bytes.toString('utf8');
      const lines = text.split(/\r?\n/);
      this.tail = lines.pop().slice(-4096);
      for (const line of lines) {
        if (line === 'VI_DIAGNOSTIC_FAILURE') {
          this.emit('log-write-failed', { fault: 'log-write-failed' }, true);
          this.diagnostics?.fail();
          continue;
        }
        if (line.startsWith('VI_DIAG ') && line.length <= 4096) {
          try {
            const entry = JSON.parse(line.slice(8));
            if (entry.run !== this.diagnostics?.runId || entry.pid !== child.pid ||
                entry.generation !== this.generation || !Number.isSafeInteger(entry.monoMs) || entry.monoMs < 0 ||
                !['begin', 'end', 'failure', 'ready', 'suspended', 'resumed', 'host-gap', 'host-resumed', 'native-start', 'exit'].includes(entry.state) ||
                !/^\d{15,20}$/.test(entry.birthFileTime || '')) {
              this.emit('stderr', { fault: 'protocol', stderrBytes: this.stderrBytes });
              continue;
            }
            this.emit(entry.state, { ...entry, nativeMonoMs: entry.monoMs, nativeTime: entry.time,
              helperPid: child.pid, component: this.component, generation: this.generation });
          } catch { this.emit('stderr', { fault: 'protocol', stderrBytes: this.stderrBytes }); }
          continue;
        }
        const fault = /error CS\d{4}/.test(line) ? 'compilation'
          : /Add-Type|Could not load file or assembly/.test(line) ? 'assembly-load'
            : /Access is denied|UnauthorizedAccessException/.test(line) ? 'access-denied'
              : /CategoryInfo|FullyQualifiedErrorId/.test(line) ? 'powershell-error' : 'unknown';
        if (line && !this.stderrClasses.has(fault)) {
          this.stderrClasses.add(fault);
          this.emit('stderr', { fault, stderrBytes: this.stderrBytes });
        }
      }
    });
    child.once('error', (error) => this.emit('failure', { fault: 'spawn', ...safeError(error) }, true));
    child.once('exit', (exitCode, signal) => this.emit('exit', { exitCode, signal, stderrBytes: this.stderrBytes,
      fault: this.closing ? 'owned-close' : 'exit' }, true));
  }
}

module.exports = { NativeTrace };
