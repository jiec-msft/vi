const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
require('./windows-hosted-guard.cjs').hostedGuard();
assert.equal(process.versions.electron, undefined, 'Fixture preparation belongs to the plain Node parent.');
const directory = path.resolve('artifacts-ci', 'caret');
let service, child;
const bounded = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Parent fixture preparation exceeded its bounded deadline.')), ms);
  })]).finally(() => clearTimeout(timer));
};
async function run() {
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  await bounded(fs.mkdir(path.join(directory, 'profile'), { recursive: true }), 5000);
  const provider = path.resolve(process.env.VI_PROVIDER_DIR);
  service = await bounded(require(path.join(provider, 'fixtures', 'provider-service.cjs')).createService(), 5000);
  const fixture = path.join(directory, 'fixture-provider');
  await bounded(fs.mkdir(fixture), 5000);
  const wav = Buffer.alloc(32044);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40);
  for (let i = 0; i < 16000; i++) wav.writeInt16LE(Math.round(Math.sin(i * Math.PI * 220 / 8000) * 3000), 44 + i * 2);
  const files = [
    { role: 'synthetic-wave', name: 'input.wav', bytes: wav },
    { role: 'provider-manifest', name: path.join('fixture-provider', 'plugin.json'), bytes: JSON.stringify({
      id: 'fixture.service', kind: 'service-provider', apiVersion: 1, entry: 'index.cjs' }) },
    { role: 'synthetic-provider-config', name: path.join('fixture-provider', 'config.json'), bytes: JSON.stringify({ endpoint: service.endpoint }) },
    { role: 'provider-entry', name: path.join('fixture-provider', 'index.cjs'), bytes:
      `exports.createSession = options => require(${JSON.stringify(path.join(provider, 'src', 'providers', 'index.cjs'))})` +
      `.createSession({...options, credentialSource: async () => ({token:'fixture-credential'})});\n` },
    { role: 'owned-settings', name: path.join('profile', 'settings.json'), bytes: JSON.stringify({
      consent: true, sounds: false, openAtLogin: false, caretIndicator: true,
      shortcut: 'Control+Alt+Shift+F9', cancelShortcut: 'Control+Alt+Shift+F10' }) },
  ];
  for (const file of files) await bounded(fs.writeFile(path.join(directory, file.name), file.bytes), 5000);
  const nonce = randomUUID();
  await bounded(fs.writeFile(path.join(directory, 'parent-preparation.json'), JSON.stringify({
    protocol: 'vi-caret-parent-preparation-v1', nonce, parentPid: process.pid, head: process.env.VI_PROBE_HEAD,
    runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, preparedBeforeLaunch: true,
    appSourceSha256: createHash('sha256').update(await fs.readFile(path.resolve('app', 'main.cjs'))).digest('hex'),
    files: files.map(({ role, name, bytes }) => ({ role, name, sha256: createHash('sha256').update(bytes).digest('hex') })),
  })), 5000);
  child = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path.resolve('scripts', 'windows-caret-ci.ps1')],
    { windowsHide: true, stdio: 'inherit', env: { ...process.env, VI_CARET_PREPARATION_NONCE: nonce } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Owned launch controller exceeded its bounded deadline.')); }, 220000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Actual App qualification failed.')); });
  });
}
run().catch((error) => {
  console.error(error instanceof assert.AssertionError ? 'Parent fixture identity/guard failed.' : error.message);
  process.exitCode = 1;
}).finally(async () => {
  if (child && child.exitCode === null) child.kill();
  await service?.close();
});
