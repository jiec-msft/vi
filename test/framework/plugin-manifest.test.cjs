const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, readFile, readdir, mkdir, symlink, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { manifest, result, pluginPreferences, jsonValue } = require('../../app/plugins/manifest.cjs');
const { inspectPackage, Registry } = require('../../app/plugins/registry.cjs');
const { PluginRuntime } = require('../../app/plugins/pipeline.cjs');
const { fakeFork } = require('./support/plugin-process.cjs');

const description = { id: 'test.algorithm', version: '1.0.0', apiVersion: 1, entry: 'index.cjs', hooks: ['final.transform'] };
test('manifest rejects incompatible APIs, unsafe entries, hooks and privacy flags', () => {
  assert.equal(manifest(description).id, 'test.algorithm');
  for (const patch of [{ apiVersion: 2 }, { entry: '../a.cjs' }, { entry: 'C:\\a.cjs' },
    { entry: '/a.cjs' }, { hooks: ['paste'] }, { hooks: ['final.transform', 'final.transform'] },
    { privacy: { suppressUnprocessed: 'false' } }, { id: '../test' }]) {
    assert.throws(() => manifest({ ...description, ...patch }));
  }
});
test('editable plugin folders keep JSON separate from code hashes and produce immutable run snapshots', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vi-plugin-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new Registry(path.join(root, 'plugins'));
  await registry.initialize();
  const builtin = registry.builtins[0];
  const directory = path.join(root, 'plugins', builtin.manifest.id);
  const configFile = path.join(directory, 'config.json');
  const entry = { id: builtin.manifest.id, hash: builtin.hash, enabled: true };
  const first = await registry.resolve(entry, false);
  const modified = { scope: 'all', rules: [{ alias: 'my command', target: 'mkdir' }] };
  await writeFile(configFile, JSON.stringify(modified));
  assert.equal((await inspectPackage(directory)).hash, builtin.hash);
  const second = await registry.resolve(entry, false);
  assert.deepEqual(second.config, modified);
  assert.notEqual(first.directory, second.directory);
  assert.deepEqual(JSON.parse(await readFile(path.join(first.directory, 'config.json'), 'utf8')), builtin.defaultConfig);
  assert.deepEqual(JSON.parse(await readFile(path.join(second.directory, 'config.json'), 'utf8')), modified);
  await registry.initialize();
  assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), modified);
  await writeFile(configFile, '{bad-json');
  await assert.rejects(registry.resolve(entry, false), /invalid-config/);
  await writeFile(configFile, '"x'.padEnd(65540, 'x'));
  await assert.rejects(registry.resolve(entry, false), /invalid-config/);
  await writeFile(path.join(directory, 'index.cjs'), '// user-owned code\n');
  await rm(path.join(directory, 'plugin.json'));
  await registry.initialize();
  assert.equal(await readFile(path.join(directory, 'index.cjs'), 'utf8'), '// user-owned code\n');
  assert.equal((await registry.discover())[0].unavailable, true, 'incomplete user folder is not overwritten');
});
test('existing inline vocabulary config migrates only when folder config does not exist', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vi-plugin-migrate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new Registry(path.join(root, 'plugins'));
  const config = { scope: 'all', rules: [{ alias: 'custom alias', target: 'custom' }] };
  await registry.initialize([{ id: 'local.technical-vocabulary', config }]);
  const configFile = path.join(root, 'plugins', 'local.technical-vocabulary', 'config.json');
  assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), config);
  await registry.initialize([{ id: 'local.technical-vocabulary', config: {} }]);
  assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), config);
});
test('snapshot config uses the validated compact bytes at and below the 64 KiB limit', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vi-plugin-config-limit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new Registry(path.join(root, 'plugins'));
  await registry.initialize();
  const builtin = registry.builtins[0];
  const configFile = path.join(registry.directory, builtin.manifest.id, 'config.json');
  const entry = { id: builtin.manifest.id, hash: builtin.hash, enabled: true };
  for (const config of [{ items: Array(15000).fill('') }, { text: 'x'.repeat(65536 - 11) }]) {
    const encoded = JSON.stringify(config);
    assert.ok(Buffer.byteLength(encoded) <= 65536);
    assert.ok(Buffer.byteLength(JSON.stringify(config, null, 2) + '\n') > 65536);
    await writeFile(configFile, encoded);
    const first = await registry.resolve(entry, false);
    assert.equal(await readFile(path.join(first.directory, 'config.json'), 'utf8'), encoded);
    assert.deepEqual((await registry.resolve(entry, false)).config, config, 'second recording accepts the same snapshot');
  }
  await assert.rejects(registry.seedConfig(root, { text: 'x'.repeat(65536) }), /invalid-config/);
});

test('cache pruning removes old revisions but preserves every live runtime and unrelated files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vi-plugin-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new Registry(path.join(root, 'plugins'));
  await registry.initialize();
  const builtin = registry.builtins[0];
  const configFile = path.join(registry.directory, builtin.manifest.id, 'config.json');
  const entry = { id: builtin.manifest.id, hash: builtin.hash, enabled: true };
  const fake = fakeFork({});
  const firstDescriptor = await registry.resolve(entry, false);
  const first = new PluginRuntime([firstDescriptor], fake.fork);
  const shared = new PluginRuntime([firstDescriptor], fake.fork);
  t.after(() => first.retire());
  t.after(() => shared.retire());
  await mkdir(path.join(registry.cacheDirectory, 'unrelated'));
  await writeFile(path.join(registry.cacheDirectory, 'unrelated', 'keep'), 'user-owned');
  const snapshots = async () => (await readdir(registry.cacheDirectory)).filter((name) => /^[a-f0-9]{64}$/.test(name));
  let current;
  for (let i = 0; i < 12; i++) {
    await writeFile(configFile, JSON.stringify({ revision: i }));
    const next = new PluginRuntime([await registry.resolve(entry, false)], fake.fork);
    if (current) await current.retire();
    current = next;
    await registry.pruneCache();
    assert.equal((await snapshots()).length, 2, 'only the original live version and current revision remain');
    assert.deepEqual(JSON.parse(await readFile(path.join(firstDescriptor.directory, 'config.json'))), builtin.defaultConfig);
  }
  await first.retire();
  await registry.pruneCache();
  assert.equal((await snapshots()).length, 2, 'a second runtime still references the original');
  await shared.retire();
  await registry.pruneCache();
  assert.equal((await snapshots()).length, 1);
  await current.retire();
  await registry.pruneCache();
  assert.deepEqual(await snapshots(), []);
  assert.equal(await readFile(path.join(registry.cacheDirectory, 'unrelated', 'keep'), 'utf8'), 'user-owned');
});

test('cache snapshots stay pinned on cancelled reusable runtimes and failed process termination', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vi-plugin-cache-close-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new Registry(path.join(root, 'plugins'));
  await registry.initialize();
  const builtin = registry.builtins[0];
  const descriptor = await registry.resolve({ id: builtin.manifest.id, hash: builtin.hash, enabled: true }, false);
  const runtime = new PluginRuntime([descriptor], fakeFork({}).fork);
  await runtime.close();
  await registry.pruneCache();
  assert.ok(await readFile(path.join(descriptor.directory, 'config.json')));
  const close = runtime.close.bind(runtime);
  runtime.close = async () => { throw new Error('termination failed'); };
  await assert.rejects(runtime.retire(), /termination failed/);
  await registry.pruneCache();
  assert.ok(await readFile(path.join(descriptor.directory, 'config.json')));
  runtime.close = close;
  await runtime.retire();
  await registry.pruneCache();
  await assert.rejects(readFile(path.join(descriptor.directory, 'config.json')), { code: 'ENOENT' });
});

test('cold-start cache cleanup removes orphan snapshots without following directory symlinks', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vi-plugin-cache-start-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = new Registry(path.join(root, 'plugins'));
  await previous.initialize();
  const builtin = previous.builtins[0];
  const entry = { id: builtin.manifest.id, hash: builtin.hash, enabled: true };
  const orphan = await previous.resolve(entry, false);
  const external = path.join(root, 'external');
  await mkdir(external);
  await writeFile(path.join(external, 'keep'), 'untouched');
  const link = path.join(previous.cacheDirectory, 'a'.repeat(64));
  await symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  const fresh = new Registry(previous.directory);
  await fresh.initialize();
  await fresh.pruneCache();
  await assert.rejects(readFile(path.join(orphan.directory, 'config.json')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(link, 'keep'), 'utf8'), 'untouched');
  await fresh.pruneCache();
  const runtime = new PluginRuntime([await fresh.resolve(entry, false)], fakeFork({}).fork);
  await fresh.pruneCache();
  assert.ok(await readFile(path.join(runtime.descriptors[0].directory, 'config.json')));
  await runtime.retire();
});
test('hook results are bounded and guard cannot transform', () => {
  assert.equal(result({ outcome: 'replace', text: '' }, 'final.transform').text, '');
  for (const value of [{ outcome: 'replace', text: '\0' }, { outcome: 'replace', text: 'a'.repeat(262145) },
    { outcome: 'keep', text: 'ignored' }, { outcome: 'keep', count: -1 }, { outcome: 'keep', raw: 'secret' }]) {
    assert.throws(() => result(value, 'final.transform'));
  }
  assert.throws(() => result({ outcome: 'replace', text: 'a' }, 'output.guard'));
  assert.throws(() => result({ outcome: 'suppress' }, 'preview.transform'));
});
test('config/settings reject excessive depth, duplicate IDs and invalid types', () => {
  assert.throws(() => jsonValue(JSON.parse('{"__proto__":{}}')));
  assert.throws(() => jsonValue({ text: 'x'.repeat(65536) }));
  assert.throws(() => pluginPreferences({ trustedLocal: 'true' }));
  const entry = { id: 'test.algorithm', hash: 'a'.repeat(64), enabled: true, config: {} };
  assert.throws(() => pluginPreferences({ entries: [entry, entry] }));
  assert.equal(pluginPreferences({ entries: [{ ...entry, config: null }] }).entries[0].config, null);
});
test('registry inspects without executing, hashes contents and rejects symlinks', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vi-plugin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'plugin.json'), JSON.stringify(description));
  await writeFile(path.join(source, 'index.cjs'), 'throw new Error("must not execute")');
  const first = await inspectPackage(source);
  const registry = new Registry(path.join(root, 'installed'));
  const installed = await registry.install(source, first.hash);
  assert.equal((await registry.resolve({ id: description.id, hash: first.hash, config: {} }, true)).hash, first.hash);
  await assert.rejects(registry.resolve({ id: description.id, hash: first.hash }, false), /trust-required/);
  await writeFile(path.join(source, 'index.cjs'), 'changed');
  await assert.rejects(registry.install(source, first.hash), /package-changed/);
  await writeFile(path.join(installed.directory, 'index.cjs'), 'tampered');
  await assert.rejects(registry.resolve({ id: description.id, hash: first.hash }, true), /package-changed/);
  await symlink(path.join(source, 'index.cjs'), path.join(source, 'linked.cjs'));
  await assert.rejects(inspectPackage(source), /symlink/);
});
