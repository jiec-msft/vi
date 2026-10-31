const fs = require('node:fs');
const path = require('node:path');

function loadProvider(directory, options) {
  const root = path.resolve(directory);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
  if (manifest.kind !== 'service-provider' || manifest.apiVersion !== 1 ||
      typeof manifest.entry !== 'string' || manifest.entry.includes('\\') ||
      manifest.entry.split('/').some((part) => !part || part === '.' || part === '..') ||
      path.posix.isAbsolute(manifest.entry) || !manifest.entry.endsWith('.cjs')) {
    throw new Error('Invalid provider manifest.');
  }
  const module = require(path.join(root, manifest.entry));
  if (typeof module.createProvider !== 'function') throw new Error('Provider factory is unavailable.');
  const provider = module.createProvider(options);
  for (const method of ['open', 'audio', 'finish', 'close', 'on']) {
    if (typeof provider?.[method] !== 'function') throw new Error('Invalid provider interface.');
  }
  return provider;
}

module.exports = { loadProvider };
