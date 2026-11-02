const { performance } = require('node:perf_hooks');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failure = (code, message) => Object.assign(new Error(message), { code });

async function acquireOwnedForeground({ driver, window, ownerPid, rendererReady, onAttempt = () => {} },
  { now = () => performance.now(), wait = pause } = {}) {
  const available = () => !window.isDestroyed() && window.isVisible() && window.isFocusable();
  if (!available() || !Number.isSafeInteger(ownerPid) || ownerPid < 1) {
    throw failure('owned-focus-unavailable', 'Owned foreground target is unavailable or not focusable.');
  }
  const handle = window.getNativeWindowHandle();
  if (!Buffer.isBuffer(handle) || handle.length !== 8 || handle.readBigUInt64LE() === 0n) {
    throw failure('owned-focus-unavailable', 'Owned foreground HWND is unavailable.');
  }
  const expected = handle.readBigUInt64LE().toString();
  await driver.warmup();
  const deadline = now() + 5000;
  const expired = () => failure('owned-focus-timeout', 'Owned foreground baseline was not established within 5000 ms.');
  let attempts = 0;
  for (;;) {
    if (now() >= deadline) throw expired();
    if (!available()) throw failure('owned-focus-unavailable', 'Owned foreground target became unavailable.');
    attempts++;
    onAttempt({ attempts });
    window.focus();
    const remaining = deadline - now();
    if (remaining <= 0) throw expired();
    let timer, actual, ready;
    try {
      [actual, ready] = await Promise.race([
        Promise.all([driver.capture(), rendererReady()]),
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(expired()), remaining); }),
      ]);
    } finally { clearTimeout(timer); }
    onAttempt({ attempts, rendererReady: ready === true,
      nativeOwner: actual?.pid === ownerPid ? 'owned' : actual?.pid > 0 ? 'foreign' : 'unavailable',
      nativeWindowMatched: actual?.window === expected });
    if (now() >= deadline) throw expired();
    if (actual?.pid === ownerPid && actual.window === expected && ready === true) return actual;
    const delay = deadline - now();
    if (delay <= 0) throw expired();
    await wait(Math.min(100, delay));
  }
}

module.exports = { acquireOwnedForeground };
