/**
 * Round 4 (container host): a backend whose engine a request used up.
 *
 * A request that runs out of its instruction budget (or hits another ceiling) leaves its ZIPP
 * engine `disposed`. The native hosts start each request's program afresh, and the Rust host
 * rebuilds its warm worker (`needs_rebuild`); here every later request was answered
 * "zipp: engine is disposed" until the page was reloaded.
 */
import { describe, it, expect } from 'vitest';
import { LocalBackendTransport } from '../src/local-backend-transport';
import type { BackendConfig, BackendWsEvent } from '../src/types';

const dec = new TextDecoder();

function transport(backend: BackendConfig, textFiles: Record<string, string>) {
  return new LocalBackendTransport({
    appId: 'r4-restart',
    storagePrefix: 'r4-restart:',
    persistStorage: false,
    backend,
    databases: [{ name: 'app', file: 'app.db', seedSql: 'CREATE TABLE IF NOT EXISTS hits (id INTEGER PRIMARY KEY);' }],
    textFiles,
    binaryFiles: {},
    runtimeUrl: '/runtime/',
    isolation: 'inline',
  });
}

async function get(t: LocalBackendTransport, p: string) {
  const r = await t.fetch({ method: 'GET', path: p, headers: {} });
  return { status: r.status, text: dec.decode(r.body) };
}

describe('r4 host: a backend comes back after a request used its engine up', () => {
  it('starts a JS backend again', async () => {
    const t = transport({ runtime: 'javascript', entry: 'b.js', mode: 'api', routes: ['/api/'] }, {
      'b.js': `var started = (globalThis.__starts = (globalThis.__starts || 0) + 1);
function handleRequest(req) {
  if (req.path === '/api/spin') { for (;;) {} }
  return { status: 200, body: 'ok' };
}`,
    });
    await t.ready;
    expect(await get(t, '/api/ok')).toEqual({ status: 200, text: 'ok' });
    expect((await get(t, '/api/spin')).status).toBe(500);
    expect(await get(t, '/api/ok')).toEqual({ status: 200, text: 'ok' });
    expect(await get(t, '/api/ok')).toEqual({ status: 200, text: 'ok' });
    t.dispose();
  });

  it('starts a Python backend again', async () => {
    const t = transport({ runtime: 'python', entry: 'b.py', mode: 'api', routes: ['/api/'] }, {
      'b.py': `
def handle_request(req):
    if req["path"] == "/api/spin":
        while True:
            pass
    return {"status": 200, "body": "ok"}
`,
    });
    await t.ready;
    expect((await get(t, '/api/spin')).status).toBe(500);
    expect(await get(t, '/api/ok')).toEqual({ status: 200, text: 'ok' });
    t.dispose();
  });

  it('starts a Rust backend again, and closes the sockets the old one held', async () => {
    const t = transport({ runtime: 'rust', entry: 'server/src/main.rs', root: 'server', mode: 'api', routes: ['/api/', '/ws'] }, {
      'server/Cargo.toml': '[package]\nname = "r4"\nversion = "0.1.0"\nedition = "2021"\n',
      'server/src/main.rs': `
use axum::{routing::get, Router, extract::ws::{WebSocketUpgrade, WebSocket, Message}, response::IntoResponse};
async fn ok() -> &'static str { "ok" }
async fn spin() -> &'static str { let mut i: u64 = 0; loop { i = i.wrapping_add(1); } }
async fn ws(upgrade: WebSocketUpgrade) -> impl IntoResponse {
    upgrade.on_upgrade(|mut socket: WebSocket| async move {
        while let Some(Ok(msg)) = socket.recv().await {
            if let Message::Text(t) = msg { let _ = socket.send(Message::Text(t)).await; }
        }
    })
}
#[tokio::main]
async fn main() {
    let app = Router::new().route("/api/ok", get(ok)).route("/api/spin", get(spin)).route("/ws", get(ws));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8080").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
`,
    });
    await t.ready;
    const events: BackendWsEvent[] = [];
    t.openWebSocket('/ws', [], (e) => events.push(e));
    await new Promise((r) => setTimeout(r, 30));
    expect(events.map((e) => e.type)).toEqual(['open']);
    expect(await get(t, '/api/ok')).toEqual({ status: 200, text: 'ok' });
    expect((await get(t, '/api/spin')).status).toBe(500);
    expect(events.filter((e) => e.type === 'close')).toHaveLength(1);
    expect(await get(t, '/api/ok')).toEqual({ status: 200, text: 'ok' });
    t.dispose();
  });
});
