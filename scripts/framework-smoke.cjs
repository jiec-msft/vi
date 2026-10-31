const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const WebSocket = require('ws');
const net = require('node:net');
const assert = require('node:assert/strict');

async function main() {
  assert.equal(process.arch, process.env.VI_EXPECTED_ARCH || process.arch);
  const executable = process.argv.find((arg) => arg.startsWith('--executable='))?.slice('--executable='.length);
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const directory = path.resolve('artifacts-ci', 'framework-smoke');
  await fs.mkdir(directory, { recursive: true });
  const profile = path.join(directory, 'profile');
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ consent: false, openAtLogin: false,
    shortcut: 'CommandOrControl+Alt+Shift+F9', cancelShortcut: 'CommandOrControl+Alt+Shift+F10' }));
  const child = spawn(executable || require('electron'), [
    ...(executable ? [] : [path.resolve('app', 'main.cjs')]), '--ci-mode=smoke', '--background',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'],
  { stdio: 'inherit' });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  let launchError;
  child.once('error', (error) => { launchError = error; process.exitCode = 1; });
  const timeout = setTimeout(() => { process.exitCode = 1; child.kill(); }, 60000);
  let socket;
  try {
    const deadline = Date.now() + 20000;
    let page;
    while (!page && Date.now() < deadline) {
      if (launchError) throw launchError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Framework exited before readiness.');
      try {
        page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.title === 'VI');
      } catch {}
      if (!page) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!page) throw new Error('Framework renderer did not start.');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    let id = 0;
    const pending = new Map();
    socket.on('close', () => {
      for (const job of pending.values()) job.reject(new Error('Framework disconnected before evaluation completed.'));
      pending.clear();
    });
    socket.on('message', (bytes) => {
      const message = JSON.parse(bytes.toString()), job = pending.get(message.id);
      if (!job) return;
      pending.delete(message.id);
      if (message.error || message.result.exceptionDetails) job.reject(new Error('Framework evaluation failed.'));
      else job.resolve(message.result.result.value);
    });
    const evaluate = (expression) => new Promise((resolve, reject) => {
      const current = ++id;
      pending.set(current, { resolve, reject });
      socket.send(JSON.stringify({ id: current, method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    let status;
    const readyBy = Date.now() + 30000;
    do {
      status = await evaluate('window.voice.status()');
      if (status.phase === 'error') throw new Error(`Framework startup error: ${status.message}`);
      if (status.phase === 'idle' && status.shortcutReady) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < readyBy);
    if (status.phase !== 'idle' || !status.shortcutReady) throw new Error('Framework did not reach idle/shortcut readiness.');
    const options = await evaluate('window.voice.providerOptions()');
    assert.equal(options.available, Boolean(executable), 'Unexpected provider installation state.');
    await evaluate('window.voice.ciQuit()');
    await exited;
    if (child.exitCode !== 0 || process.exitCode) throw new Error('Framework did not exit cleanly.');
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify({
      status: 'passed', platform: process.platform, arch: process.arch,
      providerSelected: false, providerInstalled: options.available, packaged: Boolean(executable),
      checks: ['full-framework-startup', 'idle', 'shortcuts', 'normal-exit'],
    }, null, 2));
  } finally { clearTimeout(timeout); socket?.close(); if (child.exitCode === null) child.kill(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
