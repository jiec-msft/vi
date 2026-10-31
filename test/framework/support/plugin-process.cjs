const { EventEmitter } = require('node:events');
const path = require('node:path');
const { manifest } = require('../../../app/plugins/manifest.cjs');

function descriptor(id = 'test.algorithm', hooks = ['final.transform'], privacy = false, config = {}) {
  return { manifest: manifest({ id, version: '1.0.0', apiVersion: 1, entry: 'index.cjs', hooks,
    privacy: { suppressUnprocessed: privacy } }), directory: path.join('/plugins', id), hash: 'a'.repeat(64), config };
}

function fakeFork(plugins, options = {}) {
  const children = [], calls = [];
  const fork = (_file, _args, launch) => {
    const child = new EventEmitter();
    children.push(child);
    let plugin, config;
    child.postMessage = (request) => {
      calls.push(request);
      if (request.type === 'dispose') { queueMicrotask(() => child.emit('exit', 0)); return; }
      if (request.type === 'cancel') return;
      if (options.noReply) return;
      void (async () => {
        try {
          let value;
          if (request.type === 'init') {
            plugin = plugins[request.pluginId] || plugins[path.basename(path.dirname(request.entry))] || {};
            config = request.config;
            if (plugin.validateConfig && !(await plugin.validateConfig(request.config))?.valid) throw new Error('invalid config');
            value = { ready: true };
          } else value = await plugin.hooks[request.hook]({ ...request, config });
          if (!child.killed || options.late) child.emit('message', { identity: request.identity, requestId: request.requestId, value });
        } catch { child.emit('message', { identity: request.identity, requestId: request.requestId, error: 'plugin-error' }); }
      })();
    };
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit('exit', 0));
      return true;
    };
    child.launch = launch;
    return child;
  };
  return { fork, calls, children };
}

module.exports = { descriptor, fakeFork };
