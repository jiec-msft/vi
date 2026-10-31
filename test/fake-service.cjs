const { WebSocketServer } = require('ws');

async function fakeService() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let bytes = 0;
  await new Promise((resolve) => server.once('listening', resolve));
  server.on('connection', (socket) => {
    let started = false;
    socket.on('message', (data, binary) => {
      if (binary) {
        if (!started) { socket.close(1008); return; }
        bytes += data.length;
        socket.send(JSON.stringify({ event: 'partial', text: 'Fixture preview' }));
        return;
      }
      const message = JSON.parse(data.toString());
      if (message.command === 'begin' && message.credential === 'fixture-credential') {
        started = true;
        socket.send(JSON.stringify({ event: 'ready' }));
      } else if (message.command === 'finish' && started) {
        socket.send(JSON.stringify({ event: 'final', text: bytes ? 'Fixture final text' : '' }));
      } else socket.close(1008);
    });
  });
  return {
    endpoint: `ws://127.0.0.1:${server.address().port}`,
    bytes: () => bytes,
    close: () => new Promise((resolve) => { for (const client of server.clients) client.terminate(); server.close(resolve); }),
  };
}

module.exports = { fakeService };
