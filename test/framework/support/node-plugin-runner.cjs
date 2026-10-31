const { EventEmitter } = require('node:events');
if (process.send && process.argv[2]) {
  process.parentPort = new EventEmitter();
  process.parentPort.postMessage = (data) => process.send(data);
  process.on('message', (data) => process.parentPort.emit('message', { data }));
  require(process.argv[2]);
}
