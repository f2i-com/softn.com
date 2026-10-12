/**
 * What `dist/` may be packaged as: the commit it was built from, as
 * `dist/BUILD-INFO.json` records it, must be the checkout's HEAD. An archive
 * is named for a release or a commit, and BUILD-INFO.json inside it says
 * which commit was built; the packagers do not build, and a `dist/` left from
 * an earlier build was packaged under whatever name it was given.
 */
import { execFileSync } from 'node:child_process';

/** The commit `root` has checked out. Throws when it is not a git checkout. */
export function headRevision(root) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * Why a `dist/` whose BUILD-INFO.json says `info` is not to be packaged at
 * `head`, or null. A tree that was dirty when it was built is refused unless
 * `allowDirty`, as package-site has always refused it, and so is a build made
 * without its precompressed twins.
 */
export function buildInfoProblem(info, head, { allowDirty = false } = {}) {
  const revision = info?.softn?.revision;
  if (typeof revision !== 'string' || !/^[0-9a-f]{40}$/.test(revision)) {
    return 'BUILD-INFO.json names no SoftN revision. Build the site again (npm run build:site).';
  }
  if (revision !== head) {
    return `dist/ was built from ${revision.slice(0, 10)}, not from HEAD (${head.slice(0, 10)}). Build it again from this checkout (npm run build:site), or check out the commit it was built from.`;
  }
  if (info.softn.dirty && !allowDirty) {
    return 'BUILD-INFO.json says the tree was dirty when dist/ was built. A release is built from a clean checkout; pass --allow-dirty for a local trial.';
  }
  // A test build: no .br/.gz twins, which the deployment rules prefer.
  if (info.precompressed === false) {
    return 'BUILD-INFO.json says dist/ was built with --no-precompress, for tests: it has no .br/.gz twins. Build it again without that (npm run build:site).';
  }
  return null;
}
