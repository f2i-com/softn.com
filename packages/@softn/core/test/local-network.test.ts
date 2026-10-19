/**
 * `net` with no host list is the internet, not the person's own computer or
 * network. A bundle granted `net` could send a request to a router's admin
 * page, a printer or a development server on the person's machine — from an
 * image tag, with no script at all — and those answer whoever reaches them.
 * Such an address is reached only when the app names it in `allowed_hosts`,
 * as every app in use that talks to one already does.
 */
import { describe, expect, it } from 'vitest';
import { describeNetDestination, isLocalHostname } from '../src/runtime/egress-policy';

const anyHost = { enabled: true, allow_http: true };

describe('the person’s own computer and network', () => {
  it('are not reached with net alone', () => {
    for (const url of [
      'http://localhost:3000/api',
      'http://127.0.0.1:18765/',
      'http://2130706433/',
      'http://192.168.1.1/admin',
      'http://10.0.0.5/',
      'http://172.20.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/',
      'http://0.0.0.0/',
      'http://[::1]/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
      'http://[::ffff:127.0.0.1]/',
      'https://printer.local/',
      'https://db.internal/',
      'https://router.home.arpa/',
      'https://app.localhost/',
    ]) {
      const verdict = describeNetDestination(url, anyHost);
      expect(verdict.allowed, url).toBe(false);
    }
  });

  it('are reached when the app names them', () => {
    expect(describeNetDestination('http://127.0.0.1:18765/', { ...anyHost, allowed_hosts: ['127.0.0.1'] }).allowed).toBe(true);
    expect(describeNetDestination('http://localhost/x', { ...anyHost, allowed_hosts: ['localhost'] }).allowed).toBe(true);
  });

  it('leave the internet as it was', () => {
    for (const url of ['https://example.com/', 'https://172.32.0.1/', 'https://8.8.8.8/', 'https://[2001:db8::1]/', 'https://[::ffff:808:808]/']) {
      expect(describeNetDestination(url, anyHost).allowed, url).toBe(true);
    }
    expect(isLocalHostname('local.example.com')).toBe(false);
  });
});
