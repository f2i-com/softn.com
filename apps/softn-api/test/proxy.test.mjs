/**
 * Trusted proxies (API-02, fixture F19): who may say where a request came
 * from.
 *
 * The visitor's address is what rate limits and one-rating-per-person key
 * on. It used to be taken from X-Forwarded-For whenever a single boolean in
 * the configuration said a proxy stood in front of the host — with nothing
 * checking that the request had in fact arrived through that proxy, so on a
 * host the client could reach directly, the client named its own identity.
 * Now the header is believed only when the connecting peer is a configured
 * trusted proxy, and the chain is walked from the right, skipping trusted
 * hops, to the first address that is not one.
 *
 * The resolver is a pure function, exercised here case by case through the
 * library on the command line; the servers below then show the same
 * decisions from the outside, through the comment limit, on hosts
 * configured three ways.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, runPhp, skip } from './helpers/harness.mjs';

const servers = [];
after(() => servers.forEach((s) => s.stop()));

test('the resolver believes X-Forwarded-For only from a trusted peer, and walks the chain from the right', skip, () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-proxy-'));
  const many = Array.from({ length: 20 }, () => '10.0.0.2').join(', ');
  const cases = [
    // [remote, header, trusted list, legacy boolean, expected]
    ['203.0.113.9', '198.51.100.1', [], false, '203.0.113.9', 'an untrusted peer cannot name its address'],
    ['203.0.113.9', '198.51.100.1', ['10.0.0.0/8'], false, '203.0.113.9', 'a peer outside the trusted ranges neither'],
    ['10.0.0.7', '198.51.100.1', ['10.0.0.0/8'], false, '198.51.100.1', 'a trusted peer: the address it appended'],
    ['10.0.0.7', '198.51.100.1', ['10.0.0.7'], false, '198.51.100.1', 'a single address is a trusted range of one'],
    ['10.0.0.7', '198.51.100.1, 10.0.0.8, 10.0.0.9', ['10.0.0.0/8'], false, '198.51.100.1', 'trusted hops are skipped from the right'],
    ['10.0.0.7', '1.1.1.1, 198.51.100.1', ['10.0.0.0/8'], false, '198.51.100.1', 'what the client put before its own entry is ignored'],
    ['10.0.0.7', `1.1.1.1, ${many}, 198.51.100.1`, ['10.0.0.0/8'], false, '198.51.100.1', 'a client cannot push the real entry out of reach with forged trusted hops'],
    ['10.0.0.7', many, ['10.0.0.0/8'], false, '10.0.0.7', 'more trusted hops than a chain may have: the peer'],
    ['2001:db8::10', '2001:db8:1234::5, 2001:db8::11', ['2001:db8::/48'], false, '2001:db8:1234::5', 'IPv6 ranges and hops'],
    ['2001:DB8::10', '2001:db8:1234::5', ['2001:db8::/48'], false, '2001:db8:1234::5', 'case in an IPv6 address does not matter'],
    ['::ffff:10.0.0.7', '198.51.100.1', ['10.0.0.0/8'], false, '198.51.100.1', 'an IPv4-mapped peer matches its IPv4 range'],
    ['10.0.0.7', 'unknown, 10.0.0.8', ['10.0.0.0/8'], false, '10.0.0.7', 'a malformed entry met on the walk: the peer'],
    ['10.0.0.7', 'unknown', ['10.0.0.0/8'], false, '10.0.0.7', 'a malformed header: the peer'],
    ['10.0.0.7', '', ['10.0.0.0/8'], false, '10.0.0.7', 'an empty header: the peer'],
    ['10.0.0.7', null, ['10.0.0.0/8'], false, '10.0.0.7', 'no header: the peer'],
    ['10.0.0.7', '10.0.0.5, 10.0.0.6', ['10.0.0.0/8'], false, '10.0.0.5', 'every hop trusted: the leftmost, still one of ours'],
    ['10.0.0.7', '198.51.100.1:5555, 10.0.0.8', ['10.0.0.0/8'], false, '198.51.100.1', 'a port after an IPv4 entry is dropped'],
    ['10.0.0.7', '[2001:db8:1234::5]:443, 10.0.0.8', ['10.0.0.0/8'], false, '2001:db8:1234::5', 'a bracketed IPv6 entry with a port'],
    ['10.0.0.7', '198.51.100.1', ['not-a-range', '10.0.0.0/8'], false, '198.51.100.1', 'a malformed range is ignored, the rest stand'],
    ['10.0.0.7', '198.51.100.1', ['10.0.0.0/33'], false, '10.0.0.7', 'an impossible prefix length trusts nobody'],
    ['10.0.0.7', '198.51.100.1', ['10.0.0.0/8 '], false, '198.51.100.1', 'whitespace around a range is tolerated'],
    ['10.0.0.7', '1.1.1.1, 198.51.100.1', [], true, '198.51.100.1', 'legacy trustProxy: the immediate peer is trusted, the rightmost entry is the client'],
    ['10.0.0.7', '198.51.100.1, 10.0.0.7', [], true, '198.51.100.1', "legacy: the peer's own address in the chain is a hop, not the client"],
    ['10.0.0.7', 'unknown', [], true, '10.0.0.7', 'legacy with a malformed header: the peer'],
    ['not-an-address', '198.51.100.1', ['10.0.0.0/8'], true, '0.0.0.0', 'a REMOTE_ADDR that is not an address is nobody'],
  ];
  const r = runPhp({
    dataDir,
    stdin: JSON.stringify(cases),
    script: `
$out = [];
foreach (json_decode(file_get_contents('php://stdin'), true) as $c) $out[] = Request::resolveClientIp($c[0], $c[1], $c[2], $c[3]);
echo json_encode($out);`,
  });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  cases.forEach((c, i) => assert.equal(got[i], c[4], `${c[5]} (remote ${c[0]}, header ${JSON.stringify(c[1])}, trusted ${JSON.stringify(c[2])})`));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** A comment as a given forwarded chain; the window is one per identity, so the second from the same identity is a 429. */
async function comment(s, slug, xff, text = 'A comment from behind the proxy.') {
  const headers = {};
  if (xff !== null) headers['X-Forwarded-For'] = xff;
  return s.api('POST', `/api/apps/${slug}/comments`, { body: { body: text, name: 'Visitor' }, headers });
}

test('a direct client cannot choose its rate-limit identity, and an empty trusted list trusts nobody', skip, async () => {
  const s = await startServer({ config: { trustedProxies: [], limits: { comment: [1, 600] } }, prefix: 'softn-proxy-none-' });
  servers.push(s);
  const { app } = await s.publish('Direct');
  assert.equal((await comment(s, app.slug, '203.0.113.1')).status, 201);
  const forged = await comment(s, app.slug, '203.0.113.2');
  assert.equal(forged.status, 429, 'a different forwarded address is the same visitor: the socket peer');
  assert.equal((await comment(s, app.slug, null)).status, 429, 'and so is no header at all');
  const health = (await s.api('GET', '/api/health')).json;
  assert.deepEqual(health.proxy, { trustedProxies: 0, legacyTrustProxy: false });
});

test('behind configured proxies the chain resolves the intended client, over several hops and IPv6', skip, async () => {
  const s = await startServer({
    config: { trustedProxies: ['127.0.0.1', '10.0.0.0/8', '2001:db8::/32'], limits: { comment: [1, 600] } },
    prefix: 'softn-proxy-chain-',
  });
  servers.push(s);
  const { app } = await s.publish('Chained');
  assert.equal((await comment(s, app.slug, '203.0.113.1, 10.0.0.5')).status, 201, 'the client named by the edge');
  assert.equal((await comment(s, app.slug, '203.0.113.2, 10.0.0.5')).status, 201, 'a different client has its own window');
  assert.equal((await comment(s, app.slug, '203.0.113.1, 10.0.0.6, 10.0.0.9')).status, 429, 'the same client through other hops is the same visitor');
  assert.equal((await comment(s, app.slug, '9.9.9.9, 203.0.113.2, 10.0.0.5')).status, 429, 'a forged prefix does not make a new visitor');
  assert.equal((await comment(s, app.slug, '2a00:1450::8, 2001:db8::1')).status, 201, 'an IPv6 client behind an IPv6 hop');
  assert.equal((await comment(s, app.slug, '2a00:1450::8, 2001:db8:ff::2')).status, 429);
  // The peer itself has not commented yet: a malformed chain resolves to it, and so does no header at all.
  assert.equal((await comment(s, app.slug, 'garbage, 10.0.0.5')).status, 201, 'a malformed chain falls back to the peer');
  assert.equal((await comment(s, app.slug, null)).status, 429, 'the peer, unforwarded, is the same identity');
  assert.equal((await comment(s, app.slug, 'more garbage')).status, 429, 'malformed again: still the peer, no fresh identity from junk');
  const health = (await s.api('GET', '/api/health')).json;
  assert.deepEqual(health.proxy, { trustedProxies: 3, legacyTrustProxy: false });
});

test('the legacy trustProxy boolean still means "trust the immediate peer", and is reported as such', skip, async () => {
  const s = await startServer({ config: { trustProxy: true, limits: { comment: [1, 600] } }, prefix: 'softn-proxy-legacy-' });
  servers.push(s);
  const { app } = await s.publish('Legacy');
  assert.equal((await comment(s, app.slug, 'x, 203.0.113.7')).status, 201);
  assert.equal((await comment(s, app.slug, 'y, 203.0.113.7')).status, 429, 'the rightmost entry is the client, as before');
  assert.equal((await comment(s, app.slug, 'z, 203.0.113.8')).status, 201);
  const health = (await s.api('GET', '/api/health')).json;
  assert.deepEqual(health.proxy, { trustedProxies: 0, legacyTrustProxy: true });
});
