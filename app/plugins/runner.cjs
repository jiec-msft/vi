const { result, failure, jsonValue, text } = require('./manifest.cjs');

const port = process.parentPort;
let plugin, config, hooks, identity, busy = false, current;
port.on('message', async ({ data: request }) => {
  if (request?.type === 'cancel' && request.identity === identity && request.requestId === current?.id) {
    current.controller.abort();
    return;
  }
  if (!request || busy) return;
  busy = true;
  try {
    if (request.type === 'init') {
      if (plugin) throw failure('invalid-request');
      identity = request.identity;
      config = jsonValue(request.config);
      hooks = request.hooks;
      plugin = require(request.entry);
      if (!plugin || !plugin.hooks || hooks.some((hook) => typeof plugin.hooks[hook] !== 'function')) {
        throw failure('invalid-entry');
      }
      if (plugin.validateConfig) {
        const validation = await plugin.validateConfig(config);
        if (!validation || validation.valid !== true) throw failure('invalid-config');
      }
      port.postMessage({ identity, requestId: request.requestId, value: { ready: true } });
    } else if (request.type === 'call' && request.identity === identity && hooks.includes(request.hook)) {
      text(request.inputText);
      current = { id: request.requestId, controller: new AbortController() };
      const value = await plugin.hooks[request.hook]({ ...request, config,
        signal: current.controller.signal });
      port.postMessage({ identity, requestId: request.requestId,
        value: result(value, request.hook) });
    } else if (request.type === 'dispose' && request.identity === identity) {
      await plugin?.dispose?.();
      process.exit(0);
    } else throw failure('invalid-request');
  } catch {
    // Plugin exception messages may contain transcripts or credentials.
    port.postMessage({ identity, requestId: request.requestId, error: 'plugin-error' });
  } finally { busy = false; current = undefined; }
});
