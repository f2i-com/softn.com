/**
 * The repository's root, for every script under scripts/: one place that
 * knows how deep this folder is, so a script can move between folders
 * without its idea of the root moving with it.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The checkout's root directory. */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
