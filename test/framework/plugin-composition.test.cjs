const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fork: childFork } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Registry, inspectPackage } = require('../../app/plugins/registry.cjs');
const { PluginHost } = require('../../app/plugins/host.cjs');
const { PluginRuntime } = require('../../app/plugins/pipeline.cjs');

// Exercises the actual wrapper over Node IPC; Electron-specific evidence comes from the separate probe.
function fork(runner, _args, options) {
  const child = childFork(path.join(__dirname, 'support/node-plugin-runner.cjs'), [runner], {
    env: options.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced',
  });
  child.postMessage = (message) => child.send(message);
  return child;
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vi-composition-'));
  const registry = new Registry(path.join(root, 'installed'));
  await registry.initialize();
  const resources = [];
  t.after(async () => {
    await Promise.all(resources.map((resource) => resource.close()));
    await fs.rm(root, { recursive: true, force: true });
  });
  async function synthetic(name, source) {
    const directory = path.join(root, name);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'plugin.json'), JSON.stringify({
      id: `test.${name}`, version: '1.0.0', apiVersion: 1, entry: 'index.cjs', hooks: ['final.transform'],
    }));
    await fs.writeFile(path.join(directory, 'index.cjs'), source);
    return { ...await inspectPackage(directory), config: {} };
  }
  return { root, registry, resources, synthetic };
}
test('real runner loads installed external redaction after vocabulary without host algorithm knowledge', async (t) => {
  const f = await fixture(t);
  const reference = await inspectPackage(path.join(__dirname, '../examples/plugins/redact-terms'));
  const installed = await f.registry.install(reference.directory, reference.hash);
  const vocabulary = f.registry.builtins[0];
  const runtime = new PluginRuntime([{ ...vocabulary, config: vocabulary.defaultConfig },
    { ...installed, config: { terms: ['mkdir'], replacement: '[filtered]' } }], fork);
  f.resources.push(runtime);
  await runtime.warmup();
  const pipeline = runtime.begin('external', 'developer');
  assert.equal(pipeline.privacy, true);
  assert.equal((await pipeline.final('用make dir创建目录')).text, '用[filtered]创建目录');
  await assert.rejects(pipeline.final('again'), /duplicate-final/);
});
test('final guard catches a later transform reintroducing a forbidden term', async (t) => {
  const f = await fixture(t);
  const redaction = await inspectPackage(path.join(__dirname, '../examples/plugins/redact-terms'));
  const later = await f.synthetic('later', 'module.exports={hooks:{"final.transform":()=>({outcome:"replace",text:"synthetic-secret"})}}');
  const runtime = new PluginRuntime([{ ...redaction, config: { terms: ['synthetic-secret'], replacement: '' } }, later], fork);
  f.resources.push(runtime);
  await assert.rejects(runtime.begin('guard', 'developer').final('synthetic-secret'), /blocked/);
});
test('low-level host rejects actual child death, CPU loop, invalid config and invalid output', async (t) => {
  const f = await fixture(t);
  for (const [name, source, expected] of [
    ['loop', 'module.exports={hooks:{"final.transform"(){while(true){}}}}', /timeout/],
    ['stubborn', 'process.on("SIGTERM",()=>{});module.exports={hooks:{"final.transform"(){while(true){}}}}', /timeout/],
    ['crash', 'module.exports={hooks:{"final.transform"(){process.exit(9)}}}', /process-exit/],
    ['invalid', 'module.exports={hooks:{"final.transform":()=>({outcome:"replace",text:"\\0"})}}', /plugin-error/],
    ['config', 'module.exports={validateConfig:()=>({valid:false}),hooks:{"final.transform":()=>({outcome:"keep"})}}', /plugin-error/],
  ]) {
    const host = new PluginHost(await f.synthetic(name, source), fork);
    f.resources.push(host);
    await assert.rejects(host.call('final.transform', { inputText: 'synthetic', runId: 'test', revision: 1 }, undefined, 75), expected);
    assert.equal(host.didExit, true, name);
    if (name === 'stubborn' && process.platform !== 'win32') assert.equal(host.child.signalCode, 'SIGKILL');
  }
});

test('runtime isolates real crashing, looping and invalid children while healthy transforms continue', async (t) => {
  const f = await fixture(t);
  const descriptors = [];
  for (const [name, source] of [
    ['brokeninit', 'module.exports={validateConfig(){throw Error("private config")},hooks:{}}'],
    ['brokenloop', 'module.exports={hooks:{"final.transform"(){while(true){}}}}'],
    ['brokencrash', 'module.exports={hooks:{"final.transform"(){process.exit(9)}}}'],
    ['brokenresult', 'module.exports={hooks:{"final.transform":()=>({outcome:"replace",text:"\\0"})}}'],
    ['healthy', 'module.exports={hooks:{"final.transform":({inputText})=>({outcome:"replace",text:inputText+"!"})}}'],
  ]) descriptors.push(await f.synthetic(name, source));
  const warnings = [];
  const runtime = new PluginRuntime(descriptors, fork, undefined, (warning) => warnings.push(warning));
  f.resources.push(runtime);
  await runtime.warmup();
  assert.equal((await runtime.begin('resilient', 'developer').final('dictation')).text, 'dictation!');
  assert.equal(warnings.length, 4);
  assert.deepEqual(new Set(warnings.map((warning) => warning.code)), new Set(['plugin-error', 'timeout', 'process-exit']));
  assert.ok(!JSON.stringify(warnings).includes('private config'));
  for (const descriptor of descriptors.slice(0, -1)) {
    assert.equal(runtime.hosts.get(descriptor.manifest.id).didExit, true);
  }
  const childCount = runtime.hosts.size;
  assert.equal((await runtime.begin('next', 'developer').final('again')).text, 'again!');
  assert.equal(runtime.hosts.size, childCount);
});
test('idle unload calls the public disposer before process termination', async (t) => {
  const f = await fixture(t);
  const descriptor = await f.synthetic('dispose',
    'let marker;module.exports={validateConfig(c){marker=c.marker;return {valid:true}},hooks:{"final.transform":()=>({outcome:"keep"})},dispose(){require("node:fs").writeFileSync(marker,"disposed")}}');
  const marker = path.join(f.root, 'disposed.txt');
  const host = new PluginHost({ ...descriptor, config: { marker } }, fork);
  f.resources.push(host);
  await host.start();
  await host.close();
  assert.equal(await fs.readFile(marker, 'utf8'), 'disposed');
  assert.equal(host.didExit, true);
});
test('folder config changes are visible to real plugin code only through the next immutable snapshot', async (t) => {
  const f = await fixture(t);
  const source = await f.synthetic('fileconfig',
    'module.exports={hooks:{"final.transform":()=>({outcome:"replace",text:require("./config.json").term})}}');
  const directory = path.join(f.registry.directory, source.manifest.id);
  await fs.mkdir(directory);
  for (const file of source.files) await fs.writeFile(path.join(directory, file.name), file.data);
  await fs.writeFile(path.join(directory, 'config.json'), '{"term":"first"}');
  const entry = { id: source.manifest.id, hash: source.hash, enabled: true };
  const first = new PluginRuntime([await f.registry.resolve(entry, true)], fork);
  f.resources.push(first);
  await first.warmup();
  await fs.writeFile(path.join(directory, 'config.json'), '{"term":"second"}');
  assert.equal((await first.begin('first', 'developer').final('input')).text, 'first');
  const second = new PluginRuntime([await f.registry.resolve(entry, true)], fork);
  f.resources.push(second);
  await f.registry.pruneCache();
  assert.equal((await first.begin('still-live', 'developer').final('input')).text, 'first');
  assert.equal((await second.begin('second', 'developer').final('input')).text, 'second');
  await first.retire();
  await f.registry.pruneCache();
  assert.equal((await second.begin('after-prune', 'developer').final('input')).text, 'second');
  assert.equal((await fs.readdir(f.registry.cacheDirectory)).length, 1);
  await f.registry.remove(entry);
  assert.equal((await second.begin('after-remove', 'developer').final('input')).text, 'second',
    'removing mutable source files must not delete a live execution snapshot');
  await second.retire();
  await f.registry.pruneCache();
  assert.deepEqual(await fs.readdir(f.registry.cacheDirectory), []);
});

test('real idle child exit is quarantined without respawning on a later recording', async (t) => {
  const f = await fixture(t);
  const descriptor = await f.synthetic('idleexit',
    'module.exports={hooks:{"final.transform":({inputText})=>({outcome:"replace",text:inputText+"!"})}}');
  const warnings = [];
  let starts = 0;
  const runtime = new PluginRuntime([descriptor], (...args) => { starts++; return fork(...args); },
    undefined, (warning) => warnings.push(warning));
  f.resources.push(runtime);
  await runtime.warmup();
  const host = runtime.hosts.get(descriptor.manifest.id);
  host.child.kill();
  await host.exited;
  await runtime.warmup();
  assert.equal((await runtime.begin('after-exit', 'developer').final('dictation')).text, 'dictation');
  assert.equal(starts, 1);
  assert.equal(warnings[0].code, 'process-exit');
  assert.equal(runtime.failures.size, 1);
});
