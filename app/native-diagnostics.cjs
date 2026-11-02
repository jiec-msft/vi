const { performance } = require('node:perf_hooks');
const { safeError } = require('./diagnostics.cjs');
const path = require('node:path');
const startupStages = new Set(['host-entry', 'inbox-ready', 'script-entry', 'diagnostics-ready', 'input-begin', 'input-ready',
  'forms-ready', 'clipboard-ready', 'pointer-ready', 'protocol-ready', 'ci-attest-begin', 'ci-attest-end']);
function parseNativeStartup(line, pid) {
  const match = /^VI_STARTUP ([a-z-]+) ([1-9]\d{0,9}) ([48]) ([1-9]\d?) (Desktop|Core|unknown)$/.exec(line);
  if (!match || !startupStages.has(match[1]) || Number(match[2]) !== pid) return undefined;
  return { startupStage: match[1], pointerBytes: Number(match[3]),
    powerShellMajor: Number(match[4]), powerShellEdition: match[5] };
}

class NativeTrace {
  constructor(diagnostics, component, generation) {
    this.diagnostics = diagnostics;
    this.component = component;
    this.generation = generation;
    this.started = performance.now();
    this.tail = '';
    this.stderrBytes = 0;
    this.stderrClasses = new Set();
    this.startup = [];
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
        if (line.startsWith('VI_STARTUP ')) {
          const entry = parseNativeStartup(line, child.pid);
          if (!entry || this.startup.length >= 16) this.emit('stderr', { fault: 'protocol', stderrBytes: this.stderrBytes });
          else {
            this.startup.push({ ...entry, spanMs: Math.round(performance.now() - this.started) });
            this.emit('compile', { api: 'compile', ...entry }, true);
          }
          continue;
        }
        if (line === 'VI_DIAGNOSTIC_FAILURE') {
          if (!this.sidecarFailed) {
            this.sidecarFailed = true;
            this.emit('log-write-failed', { fault: 'log-write-failed' }, true);
          }
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

function nativeHelperEnvironment(supplied = process.env) {
  const env = { ...supplied };
  for (const name of Object.keys(env)) if (name.toUpperCase() === 'PSMODULEPATH') delete env[name];
  const root = Object.entries(env).find(([name]) => name.toUpperCase() === 'SYSTEMROOT')?.[1];
  if (root !== undefined) {
    if (typeof root !== 'string' || !/^[a-z]:[\\/]/i.test(root) || !path.win32.isAbsolute(root)) {
      throw new Error('The native Windows system root must be a drive-qualified absolute path.');
    }
    env.PSModulePath = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  } else if (process.platform === 'win32') {
    throw new Error('The native Windows system root is unavailable.');
  }
  return env;
}

module.exports = { NativeTrace, nativeHelperEnvironment, parseNativeStartup };
