const fs = require('node:fs');
const path = require('node:path');

function endpoint(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\\]/.test(value)) {
    throw new Error('Invalid provider endpoint.');
  }
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid provider endpoint.'); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (!(url.protocol === 'wss:' || (url.protocol === 'ws:' && loopback)) ||
      url.username || url.password || url.search || url.hash) throw new Error('Invalid provider endpoint transport or credentials.');
  return value;
}

function siblingConfig(executable, platform) {
  if (platform !== 'darwin') return path.join(path.dirname(executable), 'VI.provider.json');
  const bundle = path.dirname(path.dirname(path.dirname(executable)));
  if (!bundle.endsWith('.app') || path.basename(path.dirname(executable)) !== 'MacOS') {
    throw new Error('Unexpected packaged application layout.');
  }
  return path.join(path.dirname(bundle), 'VI.provider.json');
}

function readConfig(file, required) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.length > 4096) {
    throw new Error('Provider configuration requires an absolute file path.');
  }
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error.code === 'ENOENT' && !required) return undefined;
    throw new Error('Provider configuration could not be read.', { cause: error });
  }
  const canonical = fs.realpathSync(file);
  const compare = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (!stat.isFile() || stat.isSymbolicLink() || compare(canonical) !== compare(path.resolve(file)) ||
      stat.size > 4096) throw new Error('Provider configuration must be a bounded regular file without symbolic links.');
  const fd = fs.openSync(file, 'r');
  let bytes;
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > 4096 || opened.ino !== stat.ino || opened.dev !== stat.dev) {
      throw new Error('Provider configuration changed while opening.');
    }
    bytes = Buffer.alloc(opened.size + 1);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (length > opened.size) throw new Error('Provider configuration changed while reading.');
    bytes = bytes.subarray(0, length);
  } finally { fs.closeSync(fd); }
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('Provider configuration is not valid JSON.'); }
  if (!data || Array.isArray(data) || Object.keys(data).sort().join(',') !== 'endpoint,schemaVersion' ||
      data.schemaVersion !== 1) throw new Error('Unsupported provider configuration schema.');
  return { endpoint: endpoint(data.endpoint) };
}

function providerOptions({ bundled, override, executable, platform, packaged,
  explicitProviderDirectory = false, explicitConfig }) {
  let external;
  if (explicitConfig !== undefined) external = readConfig(explicitConfig, true);
  else if (packaged && !explicitProviderDirectory) external = readConfig(siblingConfig(executable, platform), false);
  const result = { ...bundled, ...external };
  if (override?.endpointOverride) result.endpoint = endpoint(override.endpointOverride);
  if (!result.endpoint) throw new Error('Provider endpoint is not configured. Supply VI.provider.json or an endpoint override.');
  result.endpoint = endpoint(result.endpoint);
  return result;
}

module.exports = { endpoint, siblingConfig, readConfig, providerOptions };
