const { randomUUID, createHash } = require('node:crypto');
const { PluginHost } = require('./host.cjs');
const { LIMITS, failure, text, jsonValue } = require('./manifest.cjs');

class PluginRuntime {
  constructor(descriptors, fork, report, onWarning = () => {}) {
    this.descriptors = descriptors.map((descriptor) => ({ ...descriptor,
      manifest: { ...descriptor.manifest, hooks: [...descriptor.manifest.hooks],
        privacy: { ...descriptor.manifest.privacy } }, config: jsonValue(descriptor.config) }));
    this.fork = fork;
    this.report = report;
    this.hosts = new Map();
    this.failures = new Map();
    this.onWarning = onWarning;
    this.releaseSnapshots = this.descriptors.map((descriptor) => descriptor.retainSnapshot?.()).filter(Boolean);
  }

  host(descriptor) {
    if (this.retired) throw failure('instance-closed', descriptor.manifest.id);
    if (this.terminationError) throw this.terminationError;
    let host = this.hosts.get(descriptor.manifest.id);
    if (host?.protocolError) throw host.protocolError;
    if (host?.unexpectedExit) throw host.unexpectedExit;
    if (!host || host.closed) {
      if (host?.terminationError) throw host.terminationError;
      host = new PluginHost(descriptor, this.fork, this.report);
      this.hosts.set(descriptor.manifest.id, host);
    }
    return host;
  }

  async warmup() {
    await Promise.all(this.descriptors.map(async (descriptor) => {
      const previous = this.failures.get(descriptor.manifest.id);
      if (previous) { this.onWarning(previous); return; }
      try { await this.host(descriptor).start(); }
      catch (error) { this.skip(descriptor, error, 'init'); }
    }));
  }

  skip(descriptor, error, stage) {
    const warning = { pluginId: descriptor.manifest.id,
      code: error.pluginFailure ? error.code : 'plugin-error',
      cause: error.cause?.pluginFailure ? error.cause.code : undefined, stage };
    this.failures.set(descriptor.manifest.id, warning);
    this.onWarning(warning);
  }

  async close() {
    const results = await Promise.allSettled([...this.hosts.values()].map((host) => host.close()));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) { this.terminationError = failed.reason; throw failed.reason; }
  }

  async retire() {
    await this.close();
    this.retired = true;
    for (const release of this.releaseSnapshots) release();
    this.releaseSnapshots = [];
  }

  begin(runId, profile, signal) {
    return new Pipeline(this, runId, profile, signal);
  }
}

class Pipeline {
  constructor(runtime, runId, profile, signal) {
    this.runtime = runtime;
    this.runId = runId;
    this.context = Object.freeze({ profile });
    this.signal = signal;
    this.descriptors = runtime.descriptors;
    this.enabled = this.descriptors.length > 0 || Boolean(runtime.suppressUnprocessed);
    this.privacy = runtime.suppressUnprocessed || this.descriptors.some(({ manifest }) =>
      manifest.privacy.suppressUnprocessed || manifest.hooks.includes('output.guard'));
    this.fingerprint = createHash('sha256').update(JSON.stringify({
      plugins: this.descriptors.map(({ hash, config }) => ({ hash, config })), profile, privacy: Boolean(this.privacy),
    })).digest('hex');
    this.revision = 0;
    this.signal?.addEventListener('abort', () => {
      this.stopped = true;
      this.latest = undefined;
      this.cancelled = this.runtime.close().catch((error) => {
        this.runtime.onWarning({ pluginId: error.pluginId || 'host', code: 'termination-failed', stage: 'close' });
      });
    }, { once: true });
  }

  preview(inputText, onResult, onError) {
    if (this.stopped || this.privacy) return;
    const revision = ++this.revision;
    this.latest = { inputText, revision, onResult, onError };
    if (this.inflight) return;
    this.inflight = (async () => {
      while (this.latest && !this.stopped) {
        const job = this.latest;
        this.latest = undefined;
        try {
          let value = text(job.inputText);
          for (const descriptor of this.descriptors) {
            if (!descriptor.manifest.hooks.includes('preview.transform')) continue;
            const result = await this.call(descriptor, 'preview.transform', value, job.revision,
              this.signal, LIMITS.previewMs);
            if (!result) continue;
            if (result.outcome === 'replace') value = result.text;
          }
          if (!this.stopped && job.revision === this.revision) job.onResult(value);
        } catch (error) {
          if (!this.stopped) job.onError(error);
        }
      }
    })().finally(() => {
      this.inflight = undefined;
      const job = this.latest;
      this.latest = undefined;
      if (job && !this.stopped) this.preview(job.inputText, job.onResult, job.onError);
    });
  }

  stopPreview() {
    this.stopped = true;
    this.latest = undefined;
  }

  async call(descriptor, hook, inputText, revision, signal, budget) {
    if (this.runtime.failures.has(descriptor.manifest.id)) return;
    if (this.signal?.aborted) throw failure('cancelled');
    try {
      return await this.runtime.host(descriptor).call(hook,
        { runId: this.runId, revision, inputText, context: this.context }, signal, budget);
    } catch (error) {
      if (this.signal?.aborted) throw failure('cancelled');
      this.runtime.skip(descriptor, error, hook);
    }
  }

  async final(inputText) {
    if (this.finalStarted) throw failure('duplicate-final');
    this.finalStarted = true;
    this.stopPreview();
    await this.inflight;
    if (this.signal?.aborted) throw failure('cancelled');
    let candidate = text(inputText), suppressed = false;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    this.signal?.addEventListener('abort', cancel, { once: true });
    const deadline = setTimeout(cancel, LIMITS.finalMs);
    try {
      for (const hook of ['final.transform', 'output.guard']) {
        for (const descriptor of this.descriptors) {
          if (hook === 'final.transform' && suppressed) continue;
          if (!descriptor.manifest.hooks.includes(hook)) continue;
          if (controller.signal.aborted) {
            if (this.signal?.aborted) throw failure('cancelled');
            this.runtime.onWarning({ pluginId: descriptor.manifest.id, code: 'timeout', stage: hook });
            continue;
          }
          const value = await this.call(descriptor, hook, candidate, ++this.revision, controller.signal);
          if (!value) continue;
          if (value.outcome === 'block') throw failure('blocked', descriptor.manifest.id);
          if (value.outcome === 'replace') candidate = value.text;
          if (value.outcome === 'suppress') { candidate = ''; suppressed = true; }
        }
      }
      if (this.signal?.aborted) throw failure('cancelled');
      return Object.freeze({ id: randomUUID(), runId: this.runId, pipelineFingerprint: this.fingerprint,
        text: candidate, outcome: suppressed || !candidate.trim() ? 'suppressed' : 'approved' });
    } finally {
      clearTimeout(deadline);
      this.signal?.removeEventListener('abort', cancel);
    }
  }
}

module.exports = { PluginRuntime, Pipeline };
