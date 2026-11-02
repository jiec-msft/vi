const { once } = require('node:events');

const stages = new Set(['js-entry', 'imports-ready', 'host-verified', 'sources-verified', 'modules-loaded',
  'app-ready', 'editor-ready', 'helper-ready', 'target-verified', 'paste-verified', 'cleanup', 'complete', 'deadline']);
const errorClasses = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AggregateError', 'SystemError', 'AssertionError']);
const errorCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EBUSY', 'EPIPE', 'ETIMEDOUT', 'ERR_ASSERTION',
  'clipboard-busy', 'clipboard-format', 'clipboard-snapshot-failed', 'clipboard-changed', 'restore-failed', 'target-changed']);

class FinalDesktopLifecycle {
  constructor({ report, publish, driver, editor, output, exit, clearDeadline }) {
    Object.assign(this, { report, writeStage: publish, driver, editor, output, exit, clearDeadline });
    this.failures = [];
    this.closed = this.destroyed = this.exited = false;
  }

  record(stage, error, phase) {
    if (error === this.combined) return;
    if (!this.failures.some((failure) => failure.error === error)) {
      this.failures.push({ stage, error, phase });
      this.combined = undefined;
    }
    this.report.status = 'failed';
    this.report.error = 'Final native delivery or lifecycle failed.';
    this.report.lifecycleFailures = this.failures.map((failure) => ({
      stage: failure.stage, ...(stages.has(failure.phase) ? { phase: failure.phase } : {}),
      errorClass: errorClasses.has(failure.error?.name) ? failure.error.name : 'Error',
      ...(errorCodes.has(failure.error?.code) ? { errorCode: failure.error.code } : {}),
    }));
  }

  failure() {
    const errors = this.failures.map(({ error }) => error);
    if (errors.length > 1) this.combined ||= new AggregateError(errors, 'Final desktop operation, publication or cleanup failed.');
    return errors.length > 1 ? this.combined : errors[0];
  }

  attempt(stage, action, phase) {
    try { action(); return true; }
    catch (error) { this.record(stage, error, phase); return false; }
  }

  publish(stage) { return this.attempt('publication', () => this.writeStage(stage), stage); }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.attempt('helper-close', () => this.driver()?.close());
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.attempt('editor-destroy', () => this.editor()?.destroy());
  }

  complete() {
    if (!this.exited) {
      this.attempt('deadline-clear', this.clearDeadline);
      if (this.failures.length) this.report.status = 'failed';
      this.attempt('output', () => this.output(this.report));
      this.exited = true;
      this.attempt('exit', () => this.exit(this.failures.length || this.report.status !== 'passed' ? 1 : 0));
    }
    const failure = this.failure();
    if (failure) throw failure;
  }

  deadline() {
    this.record('deadline', new Error('Final desktop deadline exceeded.'));
    this.publish('deadline');
    this.close();
    this.destroy();
    this.complete();
  }

  async finish(operationError) {
    if (operationError) this.record('operation', operationError);
    this.publish('cleanup');
    let child, exited, timeout;
    const waiting = new AbortController();
    this.attempt('helper-wait', () => {
      child = this.driver()?.driver?.process;
      if (child && child.exitCode === null && child.signalCode === null) exited = once(child, 'exit', { signal: waiting.signal });
    });
    this.close();
    try {
      if (exited) await Promise.race([exited, new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Owned final native helper did not exit.')), 2500);
      })]);
    } catch (error) { this.record('helper-wait', error); }
    finally { clearTimeout(timeout); waiting.abort(); }
    this.report.helperExited = !child || child.exitCode !== null || child.signalCode !== null;
    this.destroy();
    if (!this.exited) this.publish('complete');
    this.complete();
  }
}

module.exports = { FinalDesktopLifecycle, stages };
