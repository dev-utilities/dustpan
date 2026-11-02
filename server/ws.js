// Minimal WebSocket server side (RFC 6455): JSON text messages, ping/pong, close.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 16 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 60000;

function frame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

export function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);

  const conn = new EventEmitter();
  let buf = Buffer.alloc(0);
  let fragments = [];
  let open = true;

  conn.send = (obj) => {
    if (open) socket.write(frame(0x1, Buffer.from(JSON.stringify(obj))));
  };
  conn.close = () => {
    if (!open) return;
    socket.write(frame(0x8));
    socket.end();
  };

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2); offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2)); offset = 10;
      }
      if (len > MAX_PAYLOAD) return socket.destroy();
      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + len) return;
      const payload = Buffer.from(buf.subarray(offset + maskLen, offset + maskLen + len));
      if (masked) {
        const mask = buf.subarray(offset, offset + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      buf = buf.subarray(offset + maskLen + len);

      if (opcode === 0x8) return conn.close();
      if (opcode === 0x9) { socket.write(frame(0xa, payload)); continue; }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x0) {
        fragments.push(payload);
        if (!fin) continue;
        const text = Buffer.concat(fragments).toString('utf8');
        fragments = [];
        try { conn.emit('message', JSON.parse(text)); } catch { /* ignore non-JSON */ }
      }
    }
  });

  // Peers that go quiet (crashed, laptop slept) count as gone. Clients send something at least every 20s.
  let lastHeard = Date.now();
  socket.on('data', () => { lastHeard = Date.now(); });
  const watchdog = setInterval(() => {
    if (Date.now() - lastHeard > IDLE_TIMEOUT_MS) socket.destroy();
  }, 10000);

  const done = () => {
    clearInterval(watchdog);
    if (!open) return;
    open = false;
    socket.destroy();
    conn.emit('close');
  };
  socket.on('close', done);
  socket.on('error', done);
  // HTTP server sockets allow half-open connections, so a peer hanging up only fires 'end'.
  socket.on('end', done);
  return conn;
}
