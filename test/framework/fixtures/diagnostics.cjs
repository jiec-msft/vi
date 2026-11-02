const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { Diagnostics } = require('../../../app/diagnostics.cjs');

async function diagnosticsFixture(t, deliveryDelayMs = 0) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vi-diagnostics-'));
  const failures = [];
  let writer, ready;
  const diagnostics = new Diagnostics(root, (error) => failures.push(error), 524288, {
    createWriter(data) {
      const module = require.resolve('../../../app/diagnostics-writer.cjs');
      writer = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
        const on=parentPort.on.bind(parentPort);
        parentPort.on=(event,listener)=>on(event,event==='message'?(data)=>{
          if(workerData.fixtureDelayMs && data.lines)setTimeout(()=>listener(data),workerData.fixtureDelayMs);
          else listener(data);
        }:listener);
        require(${JSON.stringify(module)});
        parentPort.on=on;
        if(Atomics.load(new Int32Array(workerData.control),2))throw new Error('Content writer initialization failed.');
        parentPort.postMessage({fixtureReady:true});`,
      { eval: true, workerData: { ...data, fixtureDelayMs: deliveryDelayMs } });
      ready = new Promise((resolve, reject) => {
        const finish = (error) => {
          clearTimeout(timer);
          writer.off('message', message);
          writer.off('error', failed);
          writer.off('exit', exited);
          if (error) reject(error); else resolve();
        };
        const message = (value) => {
          if (value.failed) finish(new Error('Content writer initialization failed.'));
          else if (value.fixtureReady) finish();
        };
        const failed = (error) => finish(error);
        const exited = (code) => finish(new Error(`Content writer exited before readiness (${code}).`));
        const timer = setTimeout(() => finish(new Error('Content writer readiness exceeded 2000 ms.')), 2000);
        writer.on('message', message);
        writer.on('error', failed);
        writer.on('exit', exited);
      });
      return writer;
    },
  });
  t.after(async () => {
    diagnostics.close();
    if (writer) await writer.terminate();
    await fs.rm(root, { recursive: true, force: true });
  });
  assert.ok(ready, 'Content writer was not created.');
  await ready;
  return { diagnostics, async entries() {
    const sequence = diagnostics.sequence;
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        writer.off('message', message);
        writer.off('error', failed);
        writer.off('exit', exited);
        if (error) reject(error); else resolve();
      };
      const message = (value) => {
        if (value.failed) finish(new Error('Content writer failed before acknowledgement.'));
        else if (value.seq >= sequence) finish();
      };
      const failed = (error) => finish(error);
      const exited = (code) => finish(new Error(`Content writer exited before acknowledgement (${code}).`));
      const timer = setTimeout(() => finish(new Error('Content writer acknowledgement exceeded 2000 ms.')), 2000);
      writer.on('message', message);
      writer.on('error', failed);
      writer.on('exit', exited);
      diagnostics.drain();
      if (Atomics.load(diagnostics.control, 0) >= sequence) finish();
    });
    await diagnostics.flush();
    assert.deepEqual(failures, []);
    return (await fs.readFile(path.join(root, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  } };
}

module.exports = { diagnosticsFixture };
