/**
 * Temporary folders named after the process that owns them, so a later run
 * can tell a leftover from a folder still in use. On Windows a server is
 * often ended by a hard kill (Playwright stops its webServer with taskkill),
 * and its own cleanup never runs: serve-topology's data folders piled up in
 * %TEMP% at some 21 MB an e2e run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Whether a process with this id is running (one this process may not signal is). */
export function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Removes the folders `<prefix><pid>-…` under `dir` whose process has ended,
 * and only those: a folder whose owner still runs, or whose name does not
 * say who owns it, is left alone. A reused id counts as running, so the
 * mistake this can make is to keep a folder, never to remove one in use.
 * Returns the names it removed.
 */
export function removeOrphans(prefix, dir = os.tmpdir(), running = isRunning) {
  const removed = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (!name.startsWith(prefix)) continue;
    const owner = /^(\d+)-/.exec(name.slice(prefix.length));
    if (!owner) continue;
    const pid = Number(owner[1]);
    if (pid === process.pid || running(pid)) continue;
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch (error) {
      // Another test server may be cleaning the same directory, or its PHP
      // process may still hold an open file on Windows. Try again next run.
      if (['ENOENT', 'EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) continue;
      throw error;
    }
    removed.push(name);
  }
  return removed;
}

/** A new folder `<prefix><this process's id>-<random>` under `dir`, made after removing earlier runs' orphans. */
export function ownedTempDir(prefix, dir = os.tmpdir()) {
  removeOrphans(prefix, dir);
  return fs.mkdtempSync(path.join(dir, `${prefix}${process.pid}-`));
}
