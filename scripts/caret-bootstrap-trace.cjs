const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve('artifacts-ci', 'caret', 'bootstrap.jsonl');
let sequence = 0;
const allowed = process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted' &&
  process.env.GITHUB_REPOSITORY === 'jiec-msft/vi' && process.env.VI_CARET_TRUSTED_HEAD === 'true';
const stages = new Set(['entry-loaded', 'guard-before', 'guard-after', 'electron-import-before', 'electron-import-after',
  'browser-ready', 'actor-start', 'provider-before', 'provider-after', 'app-import-before', 'app-import-after',
  'app-ready-before', 'app-ready-after', 'module-error', 'report-saved']);
function stage(name, error) {
  if (!stages.has(name)) throw new Error('Invalid bootstrap stage.');
  const row = { stage: name, sequence: ++sequence, pid: process.pid, at: Date.now(),
    head: /^[a-f0-9]{40}$/.test(process.env.VI_PROBE_HEAD || '') ? process.env.VI_PROBE_HEAD : undefined,
    runId: /^\d+$/.test(process.env.GITHUB_RUN_ID || '') ? process.env.GITHUB_RUN_ID : undefined,
    electron: Boolean(process.versions.electron),
    processRole: ['browser', 'renderer', 'utility'].includes(process.type) ? process.type : 'node-or-unknown',
    runAsNodePresent: process.env.ELECTRON_RUN_AS_NODE !== undefined,
    runAsNodeEnabled: Boolean(process.env.ELECTRON_RUN_AS_NODE),
    cwdRole: path.resolve(process.cwd()) === path.resolve(__dirname, '..') ? 'checkout' : 'other',
    entryRole: process.argv.some((arg) => arg.endsWith('windows-caret-ui.cjs')) ? 'caret-controller' : 'other',
    profileSwitchPresent: process.argv.some((arg) => arg.startsWith('--user-data-dir=')) };
  if (error) {
    if (['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'AssertionError'].includes(error.name)) row.errorClass = error.name;
    if (['ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOSPC', 'MODULE_NOT_FOUND', 'ERR_ASSERTION'].includes(error.code)) row.errorCode = error.code;
  }
  if (allowed) {
    try { fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 }); }
    catch { process.stderr.write('VI_CI_BOOT_WRITE_FAILED\n'); }
  } else process.stderr.write(`VI_CI_BOOT ${JSON.stringify(row)}\n`);
}
process.on('uncaughtExceptionMonitor', (error) => stage('module-error', error));
module.exports = { stage };
