const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { LIMITS, manifest, failure, jsonValue, pluginPreferences } = require('./manifest.cjs');

async function readConfig(directory) {
  try {
    const file = path.join(directory, 'config.json');
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > LIMITS.configBytes) throw failure('invalid-config');
    return jsonValue(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch {
    throw failure('invalid-config');
  }
}

async function inspectPackage(directory) {
  const root = path.resolve(directory);
  const files = [];
  let bytes = 0, nodes = 0;
  async function visit(relative = '') {
    if (++nodes > LIMITS.files * 2 || relative.split(path.sep).length > 16) throw failure('package-limit');
    const location = path.join(root, relative);
    const info = await fs.lstat(location);
    if (info.isSymbolicLink()) throw failure('package-symlink');
    if (relative === 'config.json') {
      if (!info.isFile() || info.size > LIMITS.configBytes) throw failure('invalid-config');
      return;
    }
    if (info.isDirectory()) {
      for (const name of (await fs.readdir(location)).sort()) await visit(path.join(relative, name));
    } else {
      if (!info.isFile() || /\.node$/i.test(relative)) throw failure('invalid-package');
      if (files.length >= LIMITS.files || info.size > LIMITS.packageBytes) throw failure('package-limit');
      const data = await fs.readFile(location);
      bytes += data.length;
      if (bytes > LIMITS.packageBytes) throw failure('package-limit');
      files.push({ name: relative.split(path.sep).join('/'), data });
    }
  }
  await visit();
  const data = files.find((file) => file.name === 'plugin.json')?.data;
  if (!data || data.length > LIMITS.manifestBytes) throw failure('invalid-manifest');
  let description;
  try { description = manifest(JSON.parse(data.toString('utf8'))); }
  catch { throw failure('invalid-manifest'); }
  if (!files.some((file) => file.name === description.entry)) throw failure('missing-entry', description.id);
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file.name}\0${file.data.length}\0`).update(file.data);
  return { manifest: description, hash: hash.digest('hex'), files, directory: root };
}

class Registry {
  constructor(directory, builtinDirectory = path.join(__dirname, 'builtin').replace('app.asar', 'app.asar.unpacked')) {
    this.directory = directory;
    this.builtinDirectory = builtinDirectory;
    this.builtins = [];
    this.cacheDirectory = path.join(path.dirname(directory), 'plugin-cache');
    this.snapshotUsers = new Map();
  }

  async initialize(entries = []) {
    this.builtins = [];
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directories = (await fs.readdir(this.builtinDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of directories) {
      const descriptor = await inspectPackage(path.join(this.builtinDirectory, entry.name));
      if (this.builtins.some((item) => item.manifest.id === descriptor.manifest.id)) throw failure('duplicate-id');
      descriptor.defaultConfig = await readConfig(descriptor.directory);
      this.builtins.push({ ...descriptor, builtin: true });
      const destination = path.join(this.directory, descriptor.manifest.id);
      let created = false;
      try { await fs.mkdir(destination, { mode: 0o700 }); created = true; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      if (created) await this.writeFiles(destination, descriptor.files);
      else if (!(await fs.lstat(destination)).isDirectory()) continue;
      const legacy = entries.find((item) => item.id === descriptor.manifest.id);
      await this.seedConfig(destination, legacy && Object.hasOwn(legacy, 'config') ? legacy.config : descriptor.defaultConfig);
    }
  }

  async writeFiles(directory, files) {
    for (const file of files) {
      const location = path.join(directory, file.name);
      await fs.mkdir(path.dirname(location), { recursive: true, mode: 0o700 });
      await fs.writeFile(location, file.data, { mode: 0o600 });
    }
  }

  async seedConfig(directory, config) {
    try { await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify(jsonValue(config)),
      { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }

  async discover() {
    const plugins = [];
    for (const entry of (await fs.readdir(this.directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(entry.name)) continue;
      try {
        const descriptor = await inspectPackage(path.join(this.directory, entry.name));
        if (descriptor.manifest.id !== entry.name) throw failure('invalid-manifest');
        plugins.push({ ...descriptor, builtin: this.builtins.some((item) => item.hash === descriptor.hash) });
      } catch {
        plugins.push({ manifest: { id: entry.name, version: 'unavailable', hooks: [] }, unavailable: true });
      }
    }
    return plugins;
  }

  async install(directory, expectedHash) {
    const descriptor = await inspectPackage(directory);
    if (this.builtins.some((item) => item.manifest.id === descriptor.manifest.id)) throw failure('reserved-id');
    if (descriptor.hash !== expectedHash) throw failure('package-changed');
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = path.join(this.directory, descriptor.manifest.id);
    const temporary = path.join(this.directory, `.install-${randomUUID()}`);
    await fs.mkdir(temporary, { mode: 0o700 });
    try {
      await this.writeFiles(temporary, descriptor.files);
      let config;
      try { await fs.lstat(path.join(directory, 'config.json')); config = await readConfig(directory); }
      catch (error) { if (error.code !== 'ENOENT') throw error; config = {}; }
      await this.seedConfig(temporary, config);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      try { await fs.rename(temporary, destination); }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
        const existing = await inspectPackage(destination);
        if (existing.hash !== descriptor.hash) throw failure('package-changed');
      }
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
    return { ...descriptor, directory: destination, builtin: false };
  }

  async resolve(entry, trustedLocal) {
    const descriptor = await this.describe(entry);
    if (!descriptor.builtin && !trustedLocal) throw failure('trust-required', entry.id);
    const config = await readConfig(descriptor.directory);
    // Execute a stable code snapshot, not mutable files that can change mid-recording.
    const snapshot = createHash('sha256').update(descriptor.hash).update(JSON.stringify(config)).digest('hex');
    const destination = path.join(this.cacheDirectory, snapshot);
    await fs.mkdir(this.cacheDirectory, { recursive: true, mode: 0o700 });
    try {
      const existing = await inspectPackage(destination);
      if (existing.hash !== descriptor.hash) throw failure('package-changed', entry.id);
      if (JSON.stringify(await readConfig(destination)) !== JSON.stringify(config)) throw failure('invalid-config', entry.id);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const temporary = path.join(this.cacheDirectory, `.snapshot-${randomUUID()}`);
      await fs.mkdir(temporary, { mode: 0o700 });
      try {
        await this.writeFiles(temporary, descriptor.files);
        await this.seedConfig(temporary, config);
        await fs.rename(temporary, destination);
      } finally { await fs.rm(temporary, { recursive: true, force: true }); }
    }
    return { ...descriptor, directory: destination, config,
      retainSnapshot: () => this.retainSnapshot(snapshot) };
  }

  retainSnapshot(snapshot) {
    this.snapshotUsers.set(snapshot, (this.snapshotUsers.get(snapshot) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = this.snapshotUsers.get(snapshot) - 1;
      if (remaining) this.snapshotUsers.set(snapshot, remaining);
      else this.snapshotUsers.delete(snapshot);
    };
  }

  async pruneCache() {
    let entries;
    try { entries = await fs.readdir(this.cacheDirectory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name) || this.snapshotUsers.has(entry.name)) continue;
      await fs.rm(path.join(this.cacheDirectory, entry.name), { recursive: true, force: true });
    }
  }

  async describe(entry) {
    pluginPreferences({ entries: [{ ...entry, enabled: Boolean(entry.enabled) }] });
    const descriptor = await inspectPackage(path.join(this.directory, entry.id));
    if (descriptor.hash !== entry.hash || descriptor.manifest.id !== entry.id) throw failure('package-changed', entry.id);
    return { ...descriptor, builtin: this.builtins.some((item) => item.hash === descriptor.hash) };
  }

  async remove(entry) {
    pluginPreferences({ entries: [{ ...entry, enabled: false }] });
    if (this.builtins.some((item) => item.manifest.id === entry.id)) throw failure('reserved-id');
    // Both components are validated by pluginPreferences before reaching this method.
    await fs.rm(path.join(this.directory, entry.id), { recursive: true, force: true });
    await this.pruneCache();
  }
}

module.exports = { Registry, inspectPackage, readConfig };
