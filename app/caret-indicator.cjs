const path = require('node:path');
const { NativeDelivery } = require('./native-delivery.cjs');
const { markerPlacement } = require('./caret-placement.cjs');

class CaretIndicator {
  constructor({ platform = process.platform, createDriver, diagnostics, validateLease = async () => false, onState = () => {} } = {}) {
    this.platform = platform;
    this.createDriver = createDriver || (() => new NativeDelivery('win32',
      path.join(__dirname, '..', 'native').replace('app.asar', 'app.asar.unpacked'),
      diagnostics, 'windows-caret.ps1'));
    this.onState = onState;
    this.validateLease = validateLease;
    this.generation = 0;
    this.state = 'disabled';
  }

  update(run, phase, enabled) {
    const eligible = enabled && this.platform === 'win32' && run?.target?.caretLease &&
      !run.cancelled && !run.target.caretInvalidated && ['recording', 'finishing'].includes(phase);
    if (!eligible) { if (this.run || this.driver || !run) this.stop(); return; }
    if (this.run === run) return;
    this.stop();
    this.run = run;
    const generation = ++this.generation;
    void this.start(run, generation).catch(() => {
      if (this.run === run && this.generation === generation) this.block('helper-unavailable');
    });
  }

  current(run, generation) { return this.run === run && this.generation === generation; }

  async start(run, generation) {
    const driver = this.createDriver();
    this.driver = driver;
    await driver.request('ready');
    if (!this.current(run, generation)) { driver.close(); return; }
    await driver.request('bind', { target: run.target });
    if (!this.current(run, generation)) return;
    const tick = async () => {
      if (!this.current(run, generation)) return;
      try {
        if (!await this.validateLease(run.target)) {
          if (this.current(run, generation)) this.block('target-changed');
          return;
        }
        if (!this.current(run, generation)) return;
        const sample = await driver.request('sample');
        if (!this.current(run, generation)) return;
        if (sample?.status === 'blocked') { this.block(sample.reason); return; }
        if (sample?.status === 'available') {
          const { caret, monitor, token } = sample;
          const rect = markerPlacement(caret, monitor);
          if (!rect) { this.block('no-adjacent-space'); return; }
          const shown = await driver.request('show', { token, rect });
          if (!this.current(run, generation)) return;
          if (shown?.visible !== true) { this.block('stale-query'); return; }
          this.setState('visible');
        } else if (sample?.status !== 'pending') {
          throw new Error('Invalid caret sample.');
        }
        if (this.current(run, generation)) this.timer = setTimeout(tick, 60);
      } catch {
        if (this.current(run, generation)) this.block('helper-unavailable');
      }
    };
    await tick();
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.onState(state);
  }

  block(reason) {
    const allowed = ['target-changed', 'secure-field', 'no-input', 'desktop-unavailable',
      'integrity-unavailable', 'caret-unavailable', 'stale-query', 'helper-unavailable', 'no-adjacent-space', 'composition-active'];
    const state = allowed.includes(reason) ? reason : 'helper-unavailable';
    // Do not authorize a later focus return or a late helper completion to revive this turn.
    if (this.run) this.run.target.caretInvalidated = true;
    this.stop();
    this.setState(state);
  }

  stop() {
    ++this.generation;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.run = undefined;
    this.driver?.close();
    this.driver = undefined;
    this.setState('hidden');
  }

  close() { this.stop(); }
}

module.exports = { CaretIndicator };
