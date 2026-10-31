const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { LIMITS, failure, result } = require('./manifest.cjs');

class PluginHost {
  constructor(descriptor, fork, report = () => {}) {
    this.descriptor = descriptor;
    this.fork = fork;
    this.report = report;
    this.identity = randomUUID();
    this.closed = false;
  }

  async start(signal) {
    if (this.closed) throw failure('instance-closed', this.id);
    if (this.ready) return this.ready;
    this.ready = (async () => {
      try {
        this.child = this.fork(path.join(__dirname, 'runner.cjs').replace('app.asar', 'app.asar.unpacked'), [], {
          stdio: 'ignore', env: { NODE_ENV: 'production' }, serviceName: 'provider text plugin',
        });
        this.exited = new Promise((resolve) => {
          this.child.once('exit', () => {
            if (!this.closing) this.unexpectedExit = failure('process-exit', this.id);
            this.didExit = true;
            this.closed = true;
            this.pending?.reject(failure('process-exit', this.id));
            resolve();
          });
        });
        this.child.once('spawn', () => {
          if (this.closed) this.child.kill();
        });
        this.child.on('message', (message) => {
          if (this.closed) return;
          if (!this.pending || message?.identity !== this.identity || message.requestId !== this.pending.id) {
            this.pending?.reject(failure('invalid-reply', this.id));
            this.protocolError = failure('invalid-reply', this.id);
            void this.close().catch((error) => { this.terminationError = error; });
            return;
          }
          if (message.error) this.pending.reject(failure('plugin-error', this.id));
          else this.pending.resolve(message.value);
        });
        this.child.on('error', () => {
          this.protocolError = failure('process-error', this.id);
          this.pending?.reject(this.protocolError);
          void this.close().catch((error) => { this.terminationError = error; });
        });
        const ready = await this.request({ type: 'init', pluginId: this.id, entry: path.join(this.descriptor.directory, this.descriptor.manifest.entry),
          hooks: this.descriptor.manifest.hooks, config: this.descriptor.config }, LIMITS.initMs, signal);
        if (!ready || ready.ready !== true) throw failure('invalid-reply', this.id);
        this.initialized = true;
      } catch (error) {
        try { await this.close(); }
        catch (closing) { if (closing !== error) closing.cause = error; throw closing; }
        throw error.pluginFailure ? error : failure('start-failed', this.id);
      }
    })();
    return this.ready;
  }

  get id() { return this.descriptor.manifest.id; }

  request(payload, budget, signal) {
    if (this.protocolError) return Promise.reject(this.protocolError);
    if (this.closed || signal?.aborted) return Promise.reject(failure('cancelled', this.id));
    if (this.pending) return Promise.reject(failure('concurrent-call', this.id));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const finish = (action, value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        this.pending = undefined;
        action(value);
      };
      const cancel = () => this.pending?.reject(failure('cancelled', this.id));
      const timer = setTimeout(() => this.pending?.reject(failure('timeout', this.id)), budget);
      this.pending = { id, resolve: (value) => finish(resolve, value), reject: (error) => {
        this.interruptedRequest = id;
        finish(reject, error);
      } };
      signal?.addEventListener('abort', cancel, { once: true });
      try { this.child.postMessage({ ...payload, identity: this.identity, requestId: id }); }
      catch { this.pending?.reject(failure('send-failed', this.id)); }
    });
  }

  async call(hook, input, signal, budget = LIMITS.callMs) {
    const started = Date.now();
    try {
      await this.start(signal);
      const value = await this.request({ type: 'call', hook, ...input }, budget, signal);
      const validated = result(value, hook, this.id);
      this.report({ pluginId: this.id, elapsedMs: Date.now() - started, hook, count: validated.count || 0 });
      return validated;
    } catch (error) {
      this.report({ pluginId: this.id, elapsedMs: Date.now() - started, hook, pluginError: error.code });
      try { await this.close(); }
      catch (closing) { if (closing !== error) closing.cause = error; throw closing; }
      throw error;
    }
  }

  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    const pending = this.pending || (this.interruptedRequest ? { id: this.interruptedRequest } : undefined);
    this.pending?.reject(failure('instance-closed', this.id));
    this.closing = (async () => {
      if (!this.child) return;
      let timer;
      if (!this.didExit && this.initialized) {
        try { this.child.postMessage({ type: pending ? 'cancel' : 'dispose', identity: this.identity,
          requestId: pending?.id }); }
        catch { this.child.kill(); }
        if (!pending) {
          await Promise.race([this.exited, new Promise((resolve) => { timer = setTimeout(resolve, 100); })]);
          clearTimeout(timer);
        }
      }
      if (!this.didExit) this.child.kill();
      await Promise.race([this.exited, new Promise((resolve) => { timer = setTimeout(resolve, 250); })]);
      clearTimeout(timer);
      if (this.child.pid && !this.didExit) {
        // Only the specific child owned by this host may be force-terminated.
        try { process.kill(this.child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw failure('termination-failed', this.id); }
      }
      await Promise.race([this.exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(failure('termination-failed', this.id)), 1000);
      })]).finally(() => clearTimeout(timer));
    })();
    return this.closing;
  }
}

module.exports = { PluginHost };
