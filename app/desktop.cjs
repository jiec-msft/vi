const path = require('node:path');
const { NativeDelivery } = require('./native-delivery.cjs');

class DesktopInput {
  constructor({ platform = process.platform, resources = path.join(__dirname, '..', 'native'), createDriver } = {}) {
    this.platform = platform;
    this.resources = resources.replace('app.asar', 'app.asar.unpacked');
    this.createDriver = createDriver || (() => new NativeDelivery(this.platform, this.resources));
  }

  async warmup() {
    if (!['win32', 'darwin'].includes(this.platform)) throw new Error('Windows and macOS only.');
    if (this.driver && !this.driver.closed) return;
    this.driver = this.createDriver();
    try {
      if ((await this.driver.request('ready'))?.ready !== true) throw new Error('Desktop input helper is not ready.');
    }
    catch (error) { this.driver.close(); throw error; }
  }

  close() { this.driver?.close(); }

  async settleWindow(handle) {
    if (this.platform !== 'win32') return;
    if (!Buffer.isBuffer(handle) || ![4, 8].includes(handle.length)) {
      throw new Error('Invalid settings window handle.');
    }
    const window = handle.length === 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
    await this.warmup();
    const value = await this.driver.request('settle-window', { window, owner: process.pid });
    if (typeof value?.placedBehind !== 'boolean') throw new Error('Settings window order could not be confirmed.');
    return value.placedBehind;
  }

  async capture(signal) {
    if (signal?.aborted) throw new Error('Input target capture was cancelled.');
    await this.warmup();
    const target = await this.driver.request('capture');
    if (signal?.aborted) throw new Error('Input target capture was cancelled.');
    if (!Number.isSafeInteger(target?.pid) || target.pid < 1 ||
        this.platform === 'win32' && !/^[1-9]\d*$/.test(target.window)) {
      throw new Error('Desktop input target capture returned invalid data.');
    }
    return target;
  }

  async held(keys) {
    await this.warmup();
    const value = await this.driver.request('held', { keys });
    if (typeof value?.held !== 'boolean') throw new Error('Shortcut release state is unavailable.');
    return value.held;
  }

  async paste(text, target, signal, onSkipped = () => {}) {
    if (!text.trim()) throw new Error('No speech was recognized.');
    if (!target || signal?.aborted) { onSkipped(target ? 'cancelled' : 'no-target'); return false; }
    if (target.caretLease && target.caretInvalidated) { onSkipped('target-changed', 'native-focus'); return false; }
    await this.warmup();
    if (signal?.aborted) { onSkipped('cancelled'); return false; }
    try {
      // Once dispatched, finish the clipboard transaction even if the recording is cancelled.
      if ((await this.driver.request('paste', { target, text }))?.requested !== true) {
        throw new Error('Desktop input returned no paste receipt. Review the field before using Copy result.');
      }
      return true;
    } catch (error) {
      if (['target-changed', 'secure-field', 'no-input', 'composition-active', 'modifiers-held', 'clipboard-changed'].includes(error.code)) {
        onSkipped(error.code, error.check);
        return false;
      }
      throw error;
    }
  }
}

module.exports = { DesktopInput };
