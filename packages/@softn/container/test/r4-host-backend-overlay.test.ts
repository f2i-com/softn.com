/**
 * Round 4 (container host): files a Rust backend writes are kept between visits.
 *
 * The overlay is exported whole (everything the app has written), so it is exported when a
 * request may have written (not GET or HEAD) and otherwise soon after, once for a burst; a
 * flush (the page hidden or closed) and dispose write it at once.
 */
import { describe, it, expect } from 'vitest';
import { BackendWorkerSession, type BackendToHostMsg } from '../src/backend-runtime';

const RUST_APP = {
  'server/Cargo.toml': '[package]\nname = "r4o"\nversion = "0.1.0"\nedition = "2021"\n',
  'server/src/main.rs': `
use axum::{routing::{get, post}, Router};
async fn ok() -> &'static str { "ok" }
async fn write_get() -> &'static str { std::fs::write("from-get.txt", "g").unwrap(); "g" }
async fn write_post() -> &'static str { std::fs::write("from-post.txt", "p").unwrap(); "p" }
#[tokio::main]
async fn main() {
    let app = Router::new().route("/api/ok", get(ok)).route("/api/get", get(write_get)).route("/api/post", post(write_post));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8080").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
`,
};

async function session() {
  const sent: BackendToHostMsg[] = [];
  const waiting = new Map<number, (m: BackendToHostMsg) => void>();
  let ready!: () => void;
  const isReady = new Promise<void>((r) => (ready = r));
  const s = new BackendWorkerSession((m) => {
    sent.push(m);
    if (m.type === 'ready') ready();
    if (m.type === 'response') waiting.get(m.reqId)?.(m);
  });
  void s.handleMessage({
    type: 'init',
    appId: 'r4-overlay',
    backend: { runtime: 'rust', entry: 'server/src/main.rs', root: 'server', mode: 'api', routes: ['/api/'] },
    databases: [],
    textFiles: RUST_APP,
    binaryFiles: {},
    runtimeUrl: '/runtime/',
  });
  await isReady;
  let next = 1;
  const request = (method: string, path: string) =>
    new Promise<BackendToHostMsg>((resolve) => {
      const reqId = next++;
      waiting.set(reqId, resolve);
      void s.handleMessage({ type: 'fetch', reqId, method, path, query: '', headers: {} });
    });
  const overlays = () =>
    sent.filter((m): m is Extract<BackendToHostMsg, { type: 'rust-overlay-persist' }> => m.type === 'rust-overlay-persist').map((m) => m.overlayJson);
  return { s, request, overlays };
}

describe('r4 host: a Rust backend\'s files are kept for more than one visit', () => {
  it('still has a file it wrote two visits ago', async () => {
    const SECRET_APP = {
      'server/Cargo.toml': RUST_APP['server/Cargo.toml'],
      'server/src/main.rs': `
use axum::{routing::{get, post}, Router};
async fn read() -> String { std::fs::read_to_string("secret.txt").unwrap_or_else(|_| "missing".to_string()) }
async fn make() -> &'static str { std::fs::write("secret.txt", "kept-secret").unwrap(); "made" }
async fn other() -> &'static str { std::fs::write("other.txt", "o").unwrap(); "other" }
#[tokio::main]
async fn main() {
    let app = Router::new().route("/api/read", get(read)).route("/api/make", post(make)).route("/api/other", post(other));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8080").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
`,
    };
    // Each visit starts from the overlay the last one kept, as LocalBackendTransport hands it over.
    let kept: string | undefined;
    const visit = async (path: string, method = 'GET') => {
      const sent: BackendToHostMsg[] = [];
      let ready!: () => void;
      const isReady = new Promise<void>((r) => (ready = r));
      let answer!: (m: Extract<BackendToHostMsg, { type: 'response' }>) => void;
      const answered = new Promise<Extract<BackendToHostMsg, { type: 'response' }>>((r) => (answer = r));
      const s = new BackendWorkerSession((m) => {
        sent.push(m);
        if (m.type === 'ready') ready();
        if (m.type === 'response') answer(m);
        if (m.type === 'rust-overlay-persist') kept = m.overlayJson;
      });
      void s.handleMessage({
        type: 'init',
        appId: 'r4-overlay-visits',
        backend: { runtime: 'rust', entry: 'server/src/main.rs', root: 'server', mode: 'api', routes: ['/api/'] },
        databases: [],
        textFiles: SECRET_APP,
        binaryFiles: {},
        runtimeUrl: '/runtime/',
        initialRustOverlay: kept,
      });
      await isReady;
      void s.handleMessage({ type: 'fetch', reqId: 1, method, path, query: '', headers: {} });
      const r = await answered;
      s.dispose();
      return new TextDecoder().decode(r.bodyBytes);
    };
    expect(await visit('/api/make', 'POST')).toBe('made');
    expect(await visit('/api/read')).toBe('kept-secret');
    expect(await visit('/api/other', 'POST')).toBe('other');
    expect(await visit('/api/read')).toBe('kept-secret');
  });
});

describe('r4 host: a Rust backend\'s written files are kept', () => {
  it('keeps a file written in a POST at once, and one written in a GET soon after', async () => {
    const { s, request, overlays } = await session();
    const before = overlays().length;
    await request('POST', '/api/post');
    expect(overlays().length).toBe(before + 1);
    expect(overlays()[overlays().length - 1]).toContain('from-post.txt');

    await request('GET', '/api/get');
    await new Promise((r) => setTimeout(r, 400));
    expect(overlays()[overlays().length - 1]).toContain('from-get.txt');

    // Nothing new written: nothing new sent.
    const settled = overlays().length;
    await request('GET', '/api/ok');
    await new Promise((r) => setTimeout(r, 400));
    expect(overlays().length).toBe(settled);
    s.dispose();
  });

  it('writes what a GET wrote when the page is hidden or the backend ends', async () => {
    const { s, request, overlays } = await session();
    await request('GET', '/api/get');
    await s.handleMessage({ type: 'flush' });
    expect(overlays()[overlays().length - 1]).toContain('from-get.txt');
    s.dispose();

    const second = await session();
    await second.request('GET', '/api/get');
    second.s.dispose();
    expect(second.overlays()[second.overlays().length - 1]).toContain('from-get.txt');
  });
});
