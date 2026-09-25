// Which visitor a live-updates connection counts against, so one visitor
// cannot hold every one of the bridge's connections.
import test from 'node:test';
import assert from 'node:assert/strict';
import {clientKey} from '../runtime/client-key.mjs';

const req = (peer, forwarded) => ({ socket: { remoteAddress: peer }, headers: forwarded ? { 'x-forwarded-for': forwarded } : {} });

test('behind the loopback proxy, the visitor is the address the proxy appended', () => {
  assert.equal(clientKey(req('127.0.0.1', '203.0.113.9')), '203.0.113.9');
  // Earlier entries are whatever the client sent; only the last is the proxy's.
  assert.equal(clientKey(req('127.0.0.1', '198.51.100.1, 203.0.113.9')), '203.0.113.9');
  assert.equal(clientKey(req('::1', '203.0.113.9')), '203.0.113.9');
});

test('a direct peer is counted as itself, whatever it claims', () => {
  assert.equal(clientKey(req('198.51.100.7', '203.0.113.9')), '198.51.100.7');
  assert.equal(clientKey(req('::ffff:198.51.100.7')), '198.51.100.7');
});

test('IPv6 visitors count by /64, as the PHP rate limits do', () => {
  assert.equal(clientKey(req('127.0.0.1', '2001:db8:1:2:aaaa::1')), '2001:db8:1:2::/64');
  assert.equal(clientKey(req('127.0.0.1', '2001:db8:1:2:bbbb:cccc:dddd:eeee')), '2001:db8:1:2::/64');
  assert.equal(clientKey(req('127.0.0.1', '2001:db8::5')), '2001:db8:0:0::/64');
});
