/**
 * The listing, card and detail queries the fixture comparison runs, shared by
 * the test (test/catalog-warm.test.mjs) and by the script that writes the
 * expected answers (make.mjs), so the two can never drift apart.
 */
import fs from 'node:fs';
import path from 'node:path';
import { runPhp } from '../../helpers/harness.mjs';

/** The PHP that answers every query the comparison covers as one JSON object. */
export const QUERY_SCRIPT = `
$out = [];
$out['list'] = Apps::list([]);
$out['listName'] = Apps::list(['sort' => 'name', 'perPage' => '48']);
$out['listNewest'] = Apps::list(['sort' => 'newest']);
$out['listTop'] = Apps::list(['sort' => 'top']);
$out['listRemixed'] = Apps::list(['sort' => 'remixed']);
$out['listRuns'] = Apps::list(['sort' => 'runs']);
$out['search'] = Apps::list(['q' => 'harbour']);
$out['searchTwoWords'] = Apps::list(['q' => 'city story']);
$out['category'] = Apps::list(['category' => 'games']);
$out['tag'] = Apps::list(['tag' => 'city']);
$out['author'] = Apps::list(['author' => 'Ada']);
$out['capStorage'] = Apps::list(['cap' => 'storage']);
$out['capNone'] = Apps::list(['cap' => 'none']);
$out['page2'] = Apps::list(['perPage' => '2', 'page' => '2', 'sort' => 'name']);
$out['card'] = []; $out['detail'] = [];
foreach (Catalog::all() as $slug => $row) {
  $out['card'][$slug] = Apps::card($row);
  $out['detail'][$slug] = Apps::detail(Apps::row($slug, true));
}
$out['all'] = Catalog::all();
$out['resolve'] = [Apps::resolveSlug('Alpha Harbour'), Apps::resolveSlug('beta-lantern')];
$out['version'] = [Apps::version('alpha'), Apps::version('alpha', 1)];
echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
`;

/** Copy the fixture's data directory somewhere disposable. */
export function copyFixture(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyFixture(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

/** Run every query against a data directory and return the parsed answers. */
export function snapshot(dataDir) {
  const r = runPhp({ dataDir, script: QUERY_SCRIPT });
  if (r.status !== 0) throw new Error(`queries failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
