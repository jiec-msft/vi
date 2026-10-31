const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const files = fs.readdirSync('test', { recursive: true }).filter((file) => file.endsWith('.test.cjs'))
  .map((file) => path.join('test', file));
if (!files.length) throw new Error('No unit tests discovered.');
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status === 0 ? 0 : 1;
