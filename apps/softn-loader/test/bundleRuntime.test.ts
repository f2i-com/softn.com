import { describe, expect, it } from 'vitest';
import { getXDB } from '@softn/core';
import { computeBundleAppId, loadBundleXDBData, processBundleSource } from '../src/bundleRuntime';

describe('loader bundle runtime', () => {
  it('uses deterministic content identity rather than a manifest display name', async () => {
    const first = await computeBundleAppId(new Uint8Array([1, 2, 3]));
    const same = await computeBundleAppId(new Uint8Array([1, 2, 3]));
    const different = await computeBundleAppId(new Uint8Array([1, 2, 4]));

    expect(first).toMatch(/^bundle-[0-9a-f]{64}$/);
    expect(same).toBe(first);
    expect(different).not.toBe(first);
  });

  it('uses the shared one-block composer in the desktop loader path', () => {
    const result = processBundleSource(
      new Map([
        [
          'ui/main.ui',
          '<import Card from="./Card.ui" /><logic>let mainReady = true;</logic><Card />',
        ],
        ['ui/Card.ui', '<logic src="../logic/card.logic" /><Text>Card</Text>'],
        ['logic/card.logic', 'import "./card-helper.logic";\nlet cardReady = true;'],
      ]),
      {
        main: 'ui/main.ui',
        files: { logic: ['logic/card.logic'] },
      }
    );

    expect(result.source.match(/<logic>/g)).toHaveLength(1);
    expect(result.source).toContain('let mainReady = true;');
    expect(result.source).toContain('let cardReady = true;');
    expect(result.source).toContain('import "logic/card-helper.logic";');
  });

  it('does not seed after an awaited load loses ownership', async () => {
    const appId = `stale-loader-${Date.now()}-${Math.random()}`;
    const xdb = getXDB(appId);
    xdb.clearAll();
    const originalReady = xdb.isReady;
    let releaseReady!: () => void;
    xdb.isReady = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    let active = true;

    try {
      const loading = loadBundleXDBData(
        new Map([
          [
            'data/tasks.xdb',
            JSON.stringify({
              collection: 'tasks',
              records: [{ id: 'stale', title: 'Must not be written' }],
            }),
          ],
        ]),
        { main: 'ui/main.ui', files: { xdb: ['data/tasks.xdb'] } },
        appId,
        () => active
      );

      active = false;
      releaseReady();
      await expect(loading).resolves.toBe(0);
      expect(xdb.getAllRaw('tasks')).toEqual([]);
    } finally {
      xdb.isReady = originalReady;
      xdb.clearAll();
    }
  });
});
