// Minimal stand-in for the `ws` package on Cloudflare Workers: an outbound WebSocket
// opened with fetch(Upgrade: websocket), exposed with the EventEmitter API Baileys uses.
import { EventEmitter } from 'node:events';

const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;

export default class WebSocket extends EventEmitter {
  static CONNECTING = CONNECTING;
  static OPEN = OPEN;
  static CLOSING = CLOSING;
  static CLOSED = CLOSED;

  constructor(url, opts = {}) {
    super();
    this.readyState = CONNECTING;
    this._ws = null;
    this._open(url, opts).catch((err) => {
      this.readyState = CLOSED;
      this.emit('error', err);
      this.emit('close', 1006, Buffer.from(String(err?.message || err)));
    });
  }

  async _open(url, opts) {
    const headers = { Upgrade: 'websocket', ...(opts.headers || {}) };
    if (opts.origin) headers.Origin = opts.origin;
    const res = await fetch(String(url).replace(/^ws/, 'http'), { headers });
    const ws = res.webSocket;
    if (!ws) {
      this.emit('unexpected-response', null, res);
      throw new Error(`WebSocket upgrade failed: HTTP ${res.status}`);
    }
    try { ws.binaryType = 'arraybuffer'; } catch { /* older runtimes */ }
    ws.accept();
    this._ws = ws;
    // Blob payloads need an async read; a promise chain keeps frames in order.
    let chain = Promise.resolve();
    ws.addEventListener('message', (ev) => {
      const d = ev.data;
      chain = chain.then(async () => {
        let buf;
        if (typeof d === 'string') buf = Buffer.from(d);
        else if (d instanceof ArrayBuffer) buf = Buffer.from(new Uint8Array(d));
        else if (ArrayBuffer.isView(d)) buf = Buffer.from(d.buffer, d.byteOffset, d.byteLength);
        else buf = Buffer.from(new Uint8Array(await d.arrayBuffer()));
        this.emit('message', buf, typeof d !== 'string');
      }).catch((err) => this.emit('error', err));
    });
    ws.addEventListener('close', (ev) => {
      this.readyState = CLOSED;
      this.emit('close', ev.code, Buffer.from(ev.reason || ''));
    });
    ws.addEventListener('error', (ev) => this.emit('error', ev.error || new Error('websocket error')));
    this.readyState = OPEN;
    this.emit('open');
  }

  send(data, cb) {
    try {
      if (this.readyState !== OPEN) throw new Error('WebSocket is not open');
      this._ws.send(data instanceof Uint8Array ? data : typeof data === 'string' ? data : new Uint8Array(data));
      cb?.();
    } catch (err) {
      if (cb) cb(err); else throw err;
    }
  }

  close(code = 1000, reason) {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return;
    this.readyState = CLOSING;
    try { this._ws?.close(code, reason); } catch { /* ignore */ }
    if (!this._ws) { this.readyState = CLOSED; this.emit('close', code, Buffer.from('')); }
  }

  terminate() { this.close(); }
  ping() {}
  pong() {}
}

export { WebSocket };
