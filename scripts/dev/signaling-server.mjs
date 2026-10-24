/**
 * Local y-webrtc signaling server for P2P data sync.
 * Run with: node scripts/dev/signaling-server.mjs
 *
 * It relays what any peer sends to every peer on the same topic, with no
 * sign-in, so it listens on this machine alone (127.0.0.1). It listened on
 * every interface, where anyone on the network could join a topic. To try
 * it from another device, name an interface: HOST=0.0.0.0 (or one address).
 * PORT is 4444 unless set.
 *
 * A browser page is let in from this machine's own origins (localhost,
 * 127.0.0.1, [::1], any port) and from those listed in ORIGINS
 * (comma-separated); a client that sends no Origin is not a page. Any page
 * in the developer's browser could join a topic before.
 */
import { WebSocketServer } from 'ws';
import http from 'http';

const port = process.env.PORT || 4444;
const host = process.env.HOST || '127.0.0.1';
const listed = new Set((process.env.ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean));
/** The most one message may hold: a y-webrtc signal is a few kilobytes. ws's own default is 100 MiB, and each is sent on to every peer of the topic. */
const MAX_MESSAGE_BYTES = 256 * 1024;
/** Topics one connection may be on at once (one a room). */
const MAX_TOPICS = 64;
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

function originAllowed(origin) {
  if (origin === undefined) return true;
  if (listed.has(origin)) return true;
  try {
    const { protocol, hostname } = new URL(origin);
    return (protocol === 'http:' || protocol === 'https:') && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]');
  } catch {
    return false;
  }
}
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
});

const topics = new Map();

function send(conn, msg) {
  try {
    if (conn.readyState === 1) conn.send(JSON.stringify(msg));
  } catch {
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
      try { conn.ping(); } catch { conn.close(); }
    }
  }, 30000);

  conn.on('pong', () => { pongReceived = true; });

  conn.on('close', () => {
    clearInterval(pingInterval);
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
          if (!subscribedTopics.has(t) && subscribedTopics.size >= MAX_TOPICS) return;
          if (!topics.has(t)) topics.set(t, new Set());
          topics.get(t).add(conn);
          subscribedTopics.add(t);
        });
        break;
      case 'unsubscribe':
        topicNames.forEach((t) => {
          const subs = topics.get(t);
          if (subs) {
            subs.delete(conn);
            if (subs.size === 0) topics.delete(t);
          }
          subscribedTopics.delete(t);
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
  if (!originAllowed(req.headers.origin)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

server.listen(port, host, () => {
  const { address, port: bound, family } = server.address();
  const shown = family === 'IPv6' ? `[${address}]` : address;
  console.log(`Signaling server running on ws://${shown}:${bound}`);
});
