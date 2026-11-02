const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { providerSetup } = require('./provider-error.cjs');
const { providerOptions } = require('./provider-config.cjs');
const { instantiateSession } = require('./provider-module.cjs');

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
  return providerSetup(loadSession);
}

function loadSession() {
  const root = directory();
  const bundled = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const options = providerOptions({ bundled, override: readOverride(), executable: process.execPath,
    platform: process.platform, packaged: app.isPackaged,
    explicitProviderDirectory: Boolean(app.commandLine.getSwitchValue('provider-dir')),
    explicitConfig: app.commandLine.hasSwitch('provider-config')
      ? app.commandLine.getSwitchValue('provider-config') : undefined });
  return instantiateSession(root, options);
}

module.exports = { providerAvailable, createSession, readOverride };
