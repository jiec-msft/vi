const { performance } = require('node:perf_hooks');
async function until(action, label, limit = 20000) {
  const deadline = performance.now() + limit;
  let active = true, refusal, pauseTimer;
  const timeout = new Promise((_, reject) => {
    refusal = setTimeout(() => reject(Object.assign(new Error(`Caret fixture deadline: ${label}`),
      { code: 'CI_ACTION_TIMEOUT' })), limit);
  });
  const poll = async () => {
    while (active && performance.now() < deadline) {
      let value;
      try { value = await action(); }
      catch {
        if (!active) return;
        throw Object.assign(new Error(`Caret fixture action failed: ${label}`), { code: 'CI_ACTION_REJECTED' });
      }
      if (!active) return;
      if (value) return value;
      await new Promise((resolve) => { pauseTimer = setTimeout(resolve, Math.min(60, Math.max(0, deadline - performance.now()))); });
    }
    throw Object.assign(new Error(`Caret fixture deadline: ${label}`), { code: 'CI_ACTION_TIMEOUT' });
  };
  try { return await Promise.race([poll(), timeout]); }
  finally { active = false; clearTimeout(refusal); clearTimeout(pauseTimer); }
}
module.exports = { until };
