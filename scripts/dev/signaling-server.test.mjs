import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

/** A port nothing listens on now. */
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Whether a TCP connection to host:port is taken. */
function reaches(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (taken) => {
      socket.destroy();
      resolve(taken);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(3000, () => done(false));
  });
}

/** This machine's IPv4 addresses other than loopback. */
const outside = Object.values(os.networkInterfaces())
  .flat()
  .filter((address) => address && !address.internal && address.family === 'IPv4')
  .map((address) => address.address);

/** Start the signaling server with `env`; its first line, once it has said it. */
async function start(t, env) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./signaling-server.mjs', import.meta.url))], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  return new Promise((resolve, reject) => {
    let said = '';
    child.stdout.on('data', (chunk) => {
      said += chunk;
      if (said.includes('\n')) resolve(said);
    });
    child.once('exit', (code) => reject(new Error(`the signaling server exited (${code}): ${said}`)));
    setTimeout(() => reject(new Error(`the signaling server said nothing: ${said}`)), 15000);
  });
}

/**
 * The development signaling server is for this machine: it relays whatever
 * any peer sends to every peer on the same topic, with no sign-in. It
 * listened on every interface, so anyone on the network could join a
 * topic. `HOST` names another interface for testing with another device.
 */
test('the signaling server listens on this machine alone unless told otherwise', async (t) => {
  const port = await freePort();
  const said = await start(t, { PORT: String(port) });
  assert.equal(await reaches('127.0.0.1', port), true);
  if (outside.length === 0) t.diagnostic('this machine has no address but loopback to try from');
  for (const address of outside) assert.equal(await reaches(address, port), false, `it is reached on ${address}`);
  assert.match(said, new RegExp(`on ws://127\\.0\\.0\\.1:${port}\\b`));
});

/** How a WebSocket to the server with `origin` ends: 'open', or the status or code it was refused with. */
function attempt(port, origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { headers: { Origin: origin } } : {});
    ws.once('open', () => {
      ws.close();
      resolve('open');
    });
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.once('error', () => resolve('error'));
  });
}

/**
 * Any page in the developer's browser could join a topic and read what was
 * relayed there, and one message could be 100 MiB, sent on to every peer.
 */
test('the signaling server lets in this machine\'s pages, and no message too large to be a signal', async (t) => {
  const port = await freePort();
  await start(t, { PORT: String(port), ORIGINS: 'https://listed.example' });
  assert.equal(await attempt(port, 'https://evil.example'), 403);
  assert.equal(await attempt(port, 'null'), 403);
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:4173', 'http://[::1]:3000', 'https://listed.example', undefined]) {
    assert.equal(await attempt(port, origin), 'open', String(origin));
  }
  const closed = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => ws.send(JSON.stringify({ type: 'publish', topic: 't', data: 'x'.repeat(300 * 1024) })));
    ws.once('close', (code) => resolve(code));
  });
  assert.equal(closed, 1009);
});