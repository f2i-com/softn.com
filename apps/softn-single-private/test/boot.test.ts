import { expect, it } from 'vitest';
import { parseBoot } from '../src/boot';

it('accepts a path-absolute endpoint and defaults the loading text', () => {
  expect(parseBoot({ version: 1, endpoint: '/games/index.php' })).toEqual({
    version: 1,
    endpoint: '/games/index.php',
    loadingText: 'Loading…',
  });
});

it.each([
  ['https://example.test/index.php', 'an absolute URL'],
  ['//example.test/index.php', 'a protocol-relative URL'],
  ['/\\example.test/index.php', 'a backslash-relative URL'],
  ['index.php', 'a relative path'],
  ['/index.php?x=1', 'a query'],
  ['/index.php#x', 'a fragment'],
  ['/index php', 'whitespace'],
  ['', 'an empty string'],
])('refuses %s (%s)', (endpoint) => {
  expect(() => parseBoot({ version: 1, endpoint })).toThrow();
});

it.each([
  [{ version: 2, endpoint: '/index.php' }],
  [{ version: 1, endpoint: '/index.php', extra: true }],
  [{ version: 1, endpoint: '/index.php', loadingText: 'x'.repeat(161) }],
  [null],
  [[]],
])('refuses a malformed boot configuration %j', (input) => {
  expect(() => parseBoot(input)).toThrow();
});
