const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

function directory() {
  const supplied = app.commandLine.getSwitchValue('provider-dir');
  if (supplied) return path.resolve(supplied);
  const bundled = path.join(process.resourcesPath, 'providers', 'default');
  return app.isPackaged ? bundled : path.join(app.getPath('userData'), 'providers', 'default');
}

function providerAvailable() { return fs.existsSync(path.join(directory(), 'plugin.json')); }

function readOverride() {
  try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'provider-options.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { endpointOverride: '' }; throw new Error('Provider settings could not be read.'); }
}

function createSession() {
  const root = directory();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
  if (manifest.apiVersion !== 1 || manifest.kind !== 'service-provider' ||
      typeof manifest.entry !== 'string' || /[\\:\x00]/.test(manifest.entry) ||
      path.posix.isAbsolute(manifest.entry) || manifest.entry.split('/').some((part) => !part || part === '..' || part === '.')) {
    throw new Error('Invalid provider manifest.');
  }
  const options = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const override = readOverride();
  if (override.endpointOverride) options.endpoint = override.endpointOverride;
  const factory = require(path.join(root, manifest.entry)).createSession;
  if (typeof factory !== 'function') throw new Error('Provider session interface unavailable.');
  return factory(options);
}

module.exports = { providerAvailable, createSession, readOverride };
