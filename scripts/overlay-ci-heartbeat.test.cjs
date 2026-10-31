const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

test('native heartbeat readers permit atomic Node replacement while retaining each open JSON version',
  { timeout: 30000 }, async () => {
    assert.ok(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted' &&
      process.env.RUNNER_OS === 'Windows' && process.platform === 'win32' &&
      process.arch === process.env.VI_EXPECTED_ARCH && ['x64', 'arm64'].includes(process.arch),
    'Heartbeat concurrency verification requires native GitHub-hosted Windows CI.');
    const directory = path.resolve('artifacts-ci', 'overlay-recovery', 'heartbeat-reader');
    await fs.mkdir(path.dirname(directory), { recursive: true });
    await fs.mkdir(directory);
    const file = path.join(directory, 'heartbeat.json'), temporary = path.join(directory, 'heartbeat.tmp');
    const write = async (sequence) => {
      const value = { pid: process.pid, time: Date.now(), sequence };
      await fs.writeFile(temporary, JSON.stringify(value));
      await fs.rename(temporary, file);
      return value;
    };
    let previous = await write(0);
    const child = spawn(process.env.VI_DESKTOP_PWSH, ['-NoProfile', '-NonInteractive', '-File',
      path.resolve('scripts', 'overlay-ci-heartbeat-reader.ps1'), '-Directory', directory,
      '-ProducerPid', String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (bytes) => { stderr += bytes; });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const timer = setTimeout(() => child.kill(), 25000);
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const receipts = [];
    try {
      let current, iteration = 0, expecting = 'opened';
      for await (const line of lines) {
        const message = JSON.parse(line);
        assert.equal(message.pid, child.pid);
        assert.equal(message.iteration, iteration);
        assert.equal(message.type, expecting);
        if (message.type === 'opened') {
          current = await write(iteration + 1);
          child.stdin.write('replacement-complete\n');
          expecting = 'read';
        } else {
          assert.deepEqual(message.old, previous);
          assert.deepEqual(message.current, current);
          assert.ok(message.sampleAt - current.time < 3000);
          receipts.push(message);
          previous = current;
          iteration++;
          expecting = 'opened';
        }
      }
      const outcome = await exited;
      assert.equal(outcome.code, 0, `Native reader exited ${JSON.stringify(outcome)}: ${stderr}`);
      assert.equal(stderr, '');
      assert.equal(iteration, 64, 'Producer/read verification stopped before all atomic replacements.');
      assert.equal(expecting, 'opened');
      await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify({ status: 'passed', producerPid: process.pid,
        readerPid: child.pid, completedAtomicReplacements: iteration, freshnessLimitMilliseconds: 3000,
        scope: 'stable file handle JSON and concurrent replacement; not desktop or old-failure cause proof', receipts }, null, 2));
    } finally {
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
  });
