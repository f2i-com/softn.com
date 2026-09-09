/**
 * Local y-webrtc signaling server for P2P data sync.
 * Run with: node scripts/signaling-server.mjs
 */
import { WebSocketServer } from 'ws';
import http from 'http';

const port = process.env.PORT || 4444;
const wss = new WebSocketServer({ noServer: true });
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
});

const topics = new Map();

function send(conn, msg) {
  try {
    if (conn.readyState === 1) conn.send(JSON.stringify(msg));
  } catch (e) {
    conn.close();
  }
}

wss.on('connection', (conn) => {
  const subscribedTopics = new Set();
  let pongReceived = true;

  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      conn.close();
      clearInterval(pingInterval);
    } else {
      pongReceived = false;
      try { conn.ping(); } catch (e) { conn.close(); }
    }
  }, 30000);

  conn.on('pong', () => { pongReceived = true; });

  conn.on('close', () => {
    subscribedTopics.forEach((topicName) => {
      const subs = topics.get(topicName);
      if (subs) {
        subs.delete(conn);
        if (subs.size === 0) topics.delete(topicName);
      }
    });
    subscribedTopics.clear();
  });

  conn.on('message', (raw) => {
    // One peer's malformed frame is that peer's problem: a throw inside a ws
    // listener is an uncaught exception that would take the whole signaling
    // process, and every other peer's connection, down with it.
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      conn.close(1003, 'expected JSON');
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    const topicNames = Array.isArray(msg.topics)
      ? msg.topics.filter((t) => typeof t === 'string' && t.length > 0 && t.length <= 256)
      : [];

    switch (msg.type) {
      case 'subscribe':
        topicNames.forEach((t) => {
          if (!topics.has(t)) topics.set(t, new Set());
          topics.get(t).add(conn);
          subscribedTopics.add(t);
        });
        break;
      case 'unsubscribe':
        topicNames.forEach((t) => {
          const subs = topics.get(t);
          if (subs) subs.delete(conn);
        });
        break;
      case 'publish':
        if (msg.topic) {
          const receivers = topics.get(msg.topic);
          if (receivers) {
            msg.clients = receivers.size;
            receivers.forEach((r) => send(r, msg));
          }
        }
        break;
      case 'ping':
        send(conn, { type: 'pong' });
        break;
    }
  });
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

server.listen(port, () => {
  console.log(`Signaling server running on ws://localhost:${port}`);
});
