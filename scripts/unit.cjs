const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function unitInvocations(platform, files) {
  if (!files.length) throw new Error('No unit tests discovered.');
  const cold = path.join('test', 'framework', 'native-types.test.cjs');
  const ordered = [...files].sort();
  // Windows fixtures share the desktop/clipboard and must not compile concurrently.
  if (platform !== 'win32') return [['--test', ...ordered]];
  return [
    ...(ordered.includes(cold) ? [['--test', '--test-concurrency=1', cold]] : []),
    ...(ordered.some((file) => file !== cold)
      ? [['--test', '--test-concurrency=1', ...ordered.filter((file) => file !== cold)]] : []),
  ];
}
if (require.main === module) {
  const files = fs.readdirSync('test', { recursive: true }).filter((file) => file.endsWith('.test.cjs'))
    .map((file) => path.join('test', file));
  for (const args of unitInvocations(process.platform, files)) {
    const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = 1;
  }
}
module.exports = { unitInvocations };
