import { it, expect, vi } from 'vitest';
import { reopenBundle } from '../src/lib/reopenBundle';
it('reopens a local import without requesting a public app or catalogue', async () => {
  const local=vi.fn(async()=> 'Local app'), remote=vi.fn(async()=> 'Public app');
  expect(await reopenBundle(async()=>({directorySlug:undefined}),local,remote)).toBe('Local app');
  expect(remote).not.toHaveBeenCalled();
});
it('refreshes directory apps and unknown names remotely', async () => {
  const local=vi.fn(async()=> 'Local app'), remote=vi.fn(async()=> 'Public app');
  await reopenBundle(async()=>({directorySlug:'public-app'}),local,remote);
  await reopenBundle(async()=>undefined,local,remote);
  expect(remote).toHaveBeenCalledTimes(2);expect(local).not.toHaveBeenCalled();
});
it('can still fetch when cache access fails', async () => {
  expect(await reopenBundle(async()=>{throw Error('cache unavailable')},async()=>null,async()=> 'Public app')).toBe('Public app');
});
