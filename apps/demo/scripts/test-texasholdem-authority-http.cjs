/**
 * The Texas Hold'em authority on the real server.
 *
 * softn-server is started on the TexasHoldem bundle directory with several
 * workers, and two clients create, join, act and view over HTTP. The VM
 * suite (test-texasholdem-authority.cjs) covers the rules; this covers the
 * route registration, the request shape softn-server hands a handler, the
 * JSON that comes back, that a hole card never crosses the wire to the
 * wrong seat — and that requests racing on one room commit one at a time,
 * which is `db.updateIf` doing its job across workers.
 *
 * Needs a built softn-server (apps/softn-server/target/{release,debug}).
 * Without one the test is skipped with a note: the binary is not committed
 * and CI does not build the Rust server for a demo's suite.
 *
 * Usage: node scripts/test-texasholdem-authority-http.cjs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const assert = require('assert/strict');
const { spawn } = require('child_process');

const serverDir = path.resolve(__dirname, '../../softn-server');
const bundleDir = path.resolve(__dirname, '../bundles/TexasHoldem');
const exe = process.platform === 'win32' ? 'softn-server.exe' : 'softn-server';
const candidates = [path.join(serverDir, 'target/release', exe), path.join(serverDir, 'target/debug', exe)];
const binary = candidates.find((p) => fs.existsSync(p));

if (!binary) {
  console.log('SKIP: no built softn-server at apps/softn-server/target; the HTTP authority test needs one (cargo build --release).');
  process.exit(0);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(url, ms = 20000) {
  const until = Date.now() + ms;
  let last = '';
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
      last = `${r.status}`;
    } catch (e) {
      last = e.message;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} did not come up: ${last}`);
}

async function main() {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-authority-'));
  const server = spawn(binary, ['run', bundleDir, '--port', String(port), '--workers', '4', '--dev', '--data-dir', dataDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const post = async (route, body) => {
    const r = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };

  try {
    await waitFor(`${base}/api/rooms/health`);
    const health = await (await fetch(`${base}/api/rooms/health`)).json();
    assert.equal(health.ok, true);

    const created = await post('/api/rooms', { name: 'Ann' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const code = created.body.code;
    const ann = created.body.ticket;
    assert.equal(created.body.you.seat, 0);

    const joined = await post('/api/rooms/join', { code, name: 'Bob' });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    const bob = joined.body.ticket;
    assert.equal(joined.body.you.seat, 1);

    const started = await post('/api/rooms/act', { code, ticket: ann, id: 'deal', expectedRevision: joined.body.revision, action: { type: 'start' } });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.view.public.phase, 'preflop');

    const annView = await post('/api/rooms/view', { code, ticket: ann });
    const bobView = await post('/api/rooms/view', { code, ticket: bob });
    assert.equal(annView.body.you.holeCards.length, 2);
    assert.equal(bobView.body.you.holeCards.length, 2);
    assert.notDeepEqual(annView.body.you.holeCards, bobView.body.you.holeCards);
    assert.deepEqual(annView.body.public.seats[1].holeCards, [], "Ann is not sent Bob's cards");
    assert.deepEqual(bobView.body.public.seats[0].holeCards, [], "Bob is not sent Ann's cards");
    for (const v of [annView, bobView]) assert.equal(JSON.stringify(v.body).includes('"deck"'), false, 'no deck on the wire');
    const anonymous = await post('/api/rooms/view', { code });
    assert.equal(anonymous.body.you, null);

    // A retry of the deal is answered from the journal, not dealt again.
    const dealtAgain = await post('/api/rooms/act', { code, ticket: ann, id: 'deal', expectedRevision: joined.body.revision, action: { type: 'start' } });
    assert.equal(dealtAgain.status, 200);
    assert.equal(dealtAgain.body.replayed, true);
    assert.deepEqual((await post('/api/rooms/view', { code, ticket: ann })).body.you.holeCards, annView.body.you.holeCards);

    // Whose turn it is acts; the other is refused; a stale view is refused.
    const turn = annView.body.public.currentTurnSeat;
    const [actor, other] = turn === 0 ? [ann, bob] : [bob, ann];
    const wrong = await post('/api/rooms/act', { code, ticket: other, id: 'w1', expectedRevision: annView.body.revision, action: { type: 'call' } });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.error.code, 'NOT_YOUR_TURN');
    const right = await post('/api/rooms/act', { code, ticket: actor, id: 'c1', expectedRevision: annView.body.revision, action: { type: 'call' } });
    assert.equal(right.status, 200, JSON.stringify(right.body));
    const stale = await post('/api/rooms/act', { code, ticket: other, id: 'c2', expectedRevision: annView.body.revision, action: { type: 'call' } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'STALE_VIEW');
    assert.equal(stale.body.revision, right.body.ack.revision);

    // Six actions decided on one view, sent at once from the seat whose turn
    // it is: one lands, the rest are refused, and the pot moved exactly once.
    const now = await post('/api/rooms/view', { code, ticket: actor === ann ? bob : ann });
    const mover = now.body.public.currentTurnSeat === 0 ? ann : bob;
    const before = now.body.public.pot;
    const racers = await Promise.all(
      Array.from({ length: 6 }, (_, i) => post('/api/rooms/act', { code, ticket: mover, id: `race-${i}`, expectedRevision: now.body.revision, action: { type: 'call' } }))
    );
    const landed = racers.filter((r) => r.status === 200);
    const refused = racers.filter((r) => r.status === 409);
    assert.equal(landed.length, 1, `exactly one of six racing actions lands: ${racers.map((r) => r.status + ':' + (r.body.error ? r.body.error.code : 'ok')).join(' ')}`);
    assert.equal(refused.length, 5);
    assert.ok(refused.every((r) => r.body.error.code === 'STALE_VIEW' || r.body.error.code === 'RETRY'));
    const after = await post('/api/rooms/view', { code, ticket: mover });
    assert.equal(after.body.revision, now.body.revision + 1, 'the revision moved once');
    assert.ok(after.body.public.pot >= before, 'and the pot did not go backwards');

    // Six people trying for the last free seats at once: the table takes as
    // many as it has, never two in one seat.
    const small = await post('/api/rooms', { name: 'Host', maxPlayers: 3 });
    const smallCode = small.body.code;
    const joiners = await Promise.all(Array.from({ length: 6 }, (_, i) => post('/api/rooms/join', { code: smallCode, name: `J${i}` })));
    const seated = joiners.filter((j) => j.status === 200);
    assert.ok(seated.length <= 2, 'two free seats, at most two seated');
    assert.equal(new Set(seated.map((j) => j.body.you.seat)).size, seated.length, 'no seat was given twice');
    assert.ok(joiners.filter((j) => j.status !== 200).every((j) => j.body.error.code === 'ROOM_FULL' || j.body.error.code === 'RETRY'));
    // Those told to retry can; the table fills and then refuses.
    let retries = 0;
    let filled = seated.length;
    while (filled < 2 && retries++ < 10) {
      const again = await post('/api/rooms/join', { code: smallCode, name: `R${retries}` });
      if (again.status === 200) filled++;
      else assert.equal(again.body.error.code, 'RETRY');
    }
    assert.equal(filled, 2);
    assert.equal((await post('/api/rooms/join', { code: smallCode, name: 'Late' })).body.error.code, 'ROOM_FULL');

    const left = await post('/api/rooms/leave', { code, ticket: bob });
    assert.equal(left.status, 200);
    const afterLeave = await post('/api/rooms/view', { code, ticket: bob });
    assert.equal(afterLeave.body.you, null, 'the ticket is revoked');

    console.log('PASS: TexasHoldem authority over HTTP on softn-server (' + path.basename(binary) + ')');
  } catch (err) {
    console.error('FAIL: TexasHoldem authority over HTTP');
    console.error(err && err.stack ? err.stack : err);
    console.error('\nserver log:\n' + log);
    process.exitCode = 1;
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* the server may still hold the database for a moment */
    }
  }
}

main();
