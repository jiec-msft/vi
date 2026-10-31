const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

class Provider extends EventEmitter {
  constructor({ endpoint, credential }) {
    super();
    const url = new URL(endpoint);
    if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('Unsupported provider transport.');
    this.endpoint = endpoint;
    this.credential = credential;
  }

  async open() {
    this.socket = new WebSocket(this.endpoint);
    this.socket.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (!['ready', 'partial', 'final'].includes(message.event)) throw new Error();
        if (message.event !== 'ready' && typeof message.text !== 'string') throw new Error();
        this.emit(message.event, message.text);
      } catch { this.emit('failure', new Error('Invalid provider response.')); }
    });
    this.socket.on('error', () => this.emit('failure', new Error('Provider connection failed.')));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Provider start timeout.')), 2000);
      this.once('ready', () => { clearTimeout(timer); resolve(); });
      this.once('failure', (error) => { clearTimeout(timer); reject(error); });
      this.socket.once('open', () => this.socket.send(JSON.stringify({ command: 'begin', credential: this.credential })));
    });
  }

  audio(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length > 32000 || bytes.length % 2) throw new Error('Invalid PCM chunk.');
    this.socket.send(bytes);
  }

  async finish() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Provider final timeout.')), 2000);
      this.once('final', (text) => { clearTimeout(timer); resolve(text); });
      this.once('failure', (error) => { clearTimeout(timer); reject(error); });
      this.socket.send(JSON.stringify({ command: 'finish' }));
    });
  }

  close() { this.socket?.terminate(); }
}

module.exports = { Provider };
