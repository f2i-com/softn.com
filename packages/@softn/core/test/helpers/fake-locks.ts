/**
 * `navigator.locks`, as much of it as a room's cache is held with
 * (sync-room-caches.ts): shared and exclusive holds of a name, and a request
 * that is answered `null` at once where `ifAvailable` finds the name held.
 * One of these stands for the browser's one lock manager of an origin, which
 * every tab of the origin asks.
 */
export function fakeLocks() {
  const held = new Map<string, { exclusive: boolean; holders: number }>();
  const waiting = new Map<string, Array<() => boolean>>();
  const locks = {
    holders: (name: string) => held.get(name)?.holders ?? 0,
    request(name: string, options: { mode?: 'shared' | 'exclusive'; ifAvailable?: boolean }, callback: (lock: object | null) => unknown) {
      const exclusive = options.mode !== 'shared';
      return new Promise((resolve, reject) => {
        const take = (): boolean => {
          const now = held.get(name);
          if (now && (exclusive || now.exclusive)) return false;
          held.set(name, { exclusive, holders: (now?.holders ?? 0) + 1 });
          Promise.resolve()
            .then(() => callback({ name }))
            .then(resolve, reject)
            .finally(() => {
              const mine = held.get(name);
              if (mine && mine.holders > 1) mine.holders--;
              else held.delete(name);
              const queue = waiting.get(name) ?? [];
              while (queue.length > 0 && queue[0]()) queue.shift();
            });
          return true;
        };
        // Asked of the browser, which answers later.
        queueMicrotask(() => {
          if (take()) return;
          if (options.ifAvailable) Promise.resolve(callback(null)).then(resolve, reject);
          else waiting.set(name, [...(waiting.get(name) ?? []), take]);
        });
      });
    },
  };
  return locks;
}
