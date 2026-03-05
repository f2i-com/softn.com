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
    const msg = JSON.parse(raw);
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'subscribe':
        (msg.topics || []).forEach((t) => {
          if (!topics.has(t)) topics.set(t, new Set());
          topics.get(t).add(conn);
          subscribedTopics.add(t);
        });
        break;
      case 'unsubscribe':
        (msg.topics || []).forEach((t) => {
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
