/**
 * The bundle the journeys carry through the deployment.
 *
 * Urbanward declares no capabilities, so the runtime renders it without a
 * consent bar in the way, and its welcome screen has a line of copy
 * ("WELCOME TO YOUR NEW CHARTER") that only the app's own UI can put on the
 * page: seeing it is seeing the bundle run, not the runtime's shell. Its
 * manifest name, filename, and slug all align ("Urbanward" / "Urbanward.softn"
 * / "urbanward"), and the bytes come from the same file the site build shipped
 * to /demos/, so what Studio opens, what the runtime receives and what the
 * publish page uploads are one artefact.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DEMO = {
  /** The manifest's name, which is what the runtime titles its tab. */
  name: 'Urbanward',
  /** Where the built site serves it, for Studio's and Builder's `?open=`. */
  url: '/demos/Urbanward.softn',
  /** Copy from the app's first screen, present only once its UI has rendered. */
  firstScreenText: 'WELCOME TO YOUR NEW CHARTER',
  /** The manifest version, as the publish page's inspection line shows it. */
  version: '0.3.0',
  /** The file on disk, for the publish page's file input. */
  file: path.join(repoRoot, 'apps/softn-web/public/demos/Urbanward.softn'),
} as const;

/** A second example, in the games category, for the directory search journey: its name is a word nobody else's is. */
export const SEARCH_DEMO = { query: 'potato', cardName: /potato peeler/i } as const;

/** Whether the demo file is where the fetch step puts it (it is gitignored). */
export function demoFileExists(): boolean {
  return fs.existsSync(DEMO.file);
}

/** The localStorage key the site keeps edit keys under; the site's own contract (apps/softn-site/src/lib/keyStore.ts). */
export const SITE_KEYS_STORAGE = 'softn.site.editKeys';
