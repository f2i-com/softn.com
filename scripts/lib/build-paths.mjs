/**
 * The build machine's own paths, kept out of what is released.
 *
 * Source maps ship with the site: they are what an error report from a
 * visitor's browser is read against, and the sources they map to are the
 * project's own, by paths relative to the build. The service workers' maps
 * were not that: workbox writes the worker to a temporary file and bundles
 * it, so each map named `C:/Users/<name>/AppData/Local/Temp/<hash>/sw.js`
 * and carried the checkout's own path in every import it had. A map like
 * that maps to nothing anyone else has and says where and by whom the
 * release was built. build-site.mjs leaves such maps out
 * (`dropMachineMaps`); the packagers refuse any file that still names a
 * path on the machine or the checkout (`buildMachinePaths`).
 */
import fs from 'node:fs';
import path from 'node:path';

/** A path on a machine: a drive, a root, a share, or a file: URL. */
const MACHINE_PATH = /^(?:[A-Za-z]:[\\/]|[\\/]|file:)/i;

/** Files read for paths: what a site serves as text. */
const TEXT = /\.(?:m?js|cjs|css|html?|json|map|txt|md|xml|svg|webmanifest|php|example)$|(?:^|\/)(?:\.htaccess|_redirects)$/i;

/** The first of a source map's sources, or its source root, that is a path on a machine, or null. */
export function machinePathIn(map) {
  if (!map || typeof map !== 'object') return null;
  const named = [map.sourceRoot, ...(Array.isArray(map.sources) ? map.sources : [])];
  return named.find((name) => typeof name === 'string' && MACHINE_PATH.test(name)) ?? null;
}

/**
 * How `dir` may be written in a file, lower-cased: with forward slashes, with
 * backslashes, and with backslashes as JSON escapes them.
 */
export function pathSpellings(dir) {
  const forward = dir.split('\\').join('/');
  const back = forward.split('/').join('\\');
  return [...new Set([forward, back, back.split('\\').join('\\\\')])].map((spelling) => spelling.toLowerCase());
}

/**
 * Of `names` (files under `dir`, relative, with forward slashes), what names
 * a path on the build machine: a source map whose sources are such paths,
 * and any text file that holds the path of `checkout`. One line for each.
 */
export function buildMachinePaths(dir, names, checkout) {
  // A checkout at a path as short as `/src` is one ordinary text may hold;
  // only the source maps are judged then.
  const spellings = checkout.length < 8 ? [] : pathSpellings(checkout);
  const found = [];
  for (const name of names) {
    if (!TEXT.test(name)) continue;
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    if (name.endsWith('.map')) {
      let map = null;
      try {
        map = JSON.parse(text);
      } catch {
        // Not a map anyone can read; what it holds is still looked at below.
      }
      const machine = machinePathIn(map);
      if (machine) {
        found.push(`${name} names a path on the build machine (${machine})`);
        continue;
      }
    }
    const lower = text.toLowerCase();
    if (spellings.some((spelling) => lower.includes(spelling))) found.push(`${name} names the checkout this was built in`);
  }
  return found;
}

/**
 * Remove every source map under `dir` whose sources are paths on the build
 * machine, with its compressed twins, and the `sourceMappingURL` comment
 * that names it in the file it maps. The paths removed, relative to `dir`.
 */
export function dropMachineMaps(dir) {
  const removed = [];
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.map')) continue;
      let map = null;
      try {
        map = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      if (!machinePathIn(map)) continue;
      for (const twin of [file, `${file}.br`, `${file}.gz`]) fs.rmSync(twin, { force: true });
      const mapped = file.slice(0, -'.map'.length);
      if (fs.existsSync(mapped)) {
        const comment = `//# sourceMappingURL=${entry.name}`;
        const text = fs.readFileSync(mapped, 'utf8');
        const kept = text.split('\n').filter((line) => line.trim() !== comment);
        if (kept.length !== text.split('\n').length) fs.writeFileSync(mapped, kept.join('\n'));
      }
      removed.push(path.relative(dir, file).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return removed.sort();
}
