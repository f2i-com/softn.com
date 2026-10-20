import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
