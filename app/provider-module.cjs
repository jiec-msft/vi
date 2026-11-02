const fs = require('node:fs');
const path = require('node:path');

function instantiateSession(root, options) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
  if (manifest.apiVersion !== 1 || manifest.kind !== 'service-provider' ||
      typeof manifest.entry !== 'string' || /[\\:\x00]/.test(manifest.entry) ||
      path.posix.isAbsolute(manifest.entry) || manifest.entry.split('/').some((part) => !part || part === '..' || part === '.')) {
    throw new Error('Invalid provider manifest.');
  }
  const factory = require(path.join(root, manifest.entry)).createSession;
  if (typeof factory !== 'function') throw new Error('Provider session interface unavailable.');
  return factory(options);
}

module.exports = { instantiateSession };
