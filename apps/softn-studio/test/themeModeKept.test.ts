/**
 * Studio does not make up a theme for a project that declares none.
 *
 * A runtime draws an app on the side its manifest declares in
 * `config.theme.mode`, over the visitor's device and the site's theme; a
 * manifest with no mode follows the visitor. So a mode that an editor writes
 * in on the way through is no longer harmless: an app that followed its
 * visitor would come out of a no-op round trip pinned to one side. Pinned
 * here for every way a manifest passes through Studio: an import, the plan
 * worked out from it, and the export. (The scaffold of a new app does choose a
 * side, from the style the person picked in the brief: dark for Dark, light
 * for Clean, Bold, Minimal and Playful, as the wizard's swatches show them.)
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { buildBundle } from '../src/lib/exportBundle';
import { openImportedInStores } from '../src/lib/importedProject';
import { readProjectArchive } from '../src/lib/projectImport';
import { declaredThemeMode } from '../src/lib/previewProject';
import { generateBlueprintFromBrief, scaffoldProjectFiles } from '../src/lib/studioProject';
import { useAIStore, useVFSStore, useWorkspaceStore } from '../src/stores';
import type { ProjectBrief } from '../src/types/studio';

beforeEach(() => {
  useWorkspaceStore.getState().reset();
  useVFSStore.getState().reset();
  useAIStore.getState().resetSession();
});

const page = { path: 'ui/main.ui', content: '<App>\n  <Text>Notes</Text>\n</App>\n' };
const manifestOf = (config?: unknown) => JSON.stringify({ name: 'Notes', version: '1.0.0', main: 'ui/main.ui', ...(config === undefined ? {} : { config }) });

/** Import, then export untouched, and read the manifest that comes out. */
function throughStudio(manifest: string): Record<string, unknown> {
  openImportedInStores('notes.softn', [{ path: 'manifest.json', content: manifest }, page]);
  const out = readProjectArchive(buildBundle(useVFSStore.getState().getSnapshot())).find((entry) => entry.path === 'manifest.json');
  return JSON.parse(out!.content as string) as Record<string, unknown>;
}

describe('a project’s declared theme, through Studio', () => {
  it('comes out with no mode when it came in with none', () => {
    expect(throughStudio(manifestOf())).not.toHaveProperty('config');
    expect(throughStudio(manifestOf({ window: { width: 900 } })).config).toEqual({ window: { width: 900 } });
    expect(throughStudio(manifestOf({ theme: { accent: '#ff0000' } })).config).toEqual({ theme: { accent: '#ff0000' } });
    // And the file in the project is the one that was imported, byte for byte.
    expect(useVFSStore.getState().readFile('manifest.json')).toBe(manifestOf({ theme: { accent: '#ff0000' } }));
  });

  it('comes out with the mode it came in with, whatever that was', () => {
    for (const mode of ['light', 'dark', 'system', 'sepia']) {
      expect((throughStudio(manifestOf({ theme: { mode } })).config as { theme: { mode: string } }).theme.mode).toBe(mode);
    }
  });

  it('is read for the preview as it is written, and as nothing when it is not there', () => {
    expect(declaredThemeMode(JSON.parse(manifestOf()) as Record<string, unknown>)).toBeUndefined();
    expect(declaredThemeMode(JSON.parse(manifestOf({ theme: {} })) as Record<string, unknown>)).toBeUndefined();
    expect(declaredThemeMode(JSON.parse(manifestOf({ theme: 'dark' })) as Record<string, unknown>)).toBeUndefined();
    expect(declaredThemeMode(JSON.parse(manifestOf({ theme: { mode: 'system' } })) as Record<string, unknown>)).toBe('system');
    expect(declaredThemeMode(null)).toBeUndefined();
  });

  it('is chosen only for a new app, from the style of its brief', () => {
    const modes = Object.fromEntries((['clean', 'bold', 'minimal', 'playful', 'dark'] as const).map((style) => {
      const brief: ProjectBrief = { appName: 'Notes', description: 'Notes.', target: 'web', pages: ['Home'], collections: [], authNeeded: false, style, referenceImages: [], logicLanguage: 'javascript' };
      const manifest = scaffoldProjectFiles(brief, generateBlueprintFromBrief(brief)).find((f) => f.path === 'manifest.json')!;
      return [style, (JSON.parse(manifest.content) as { config: { theme: { mode: string } } }).config.theme.mode];
    }));
    // Dark is the dark one. Only Minimal used to be light, so Clean, Bold and Playful, drawn
    // light in the wizard, made dark apps, and Dark differed from them in its accent alone.
    expect(modes).toEqual({ clean: 'light', bold: 'light', minimal: 'light', playful: 'light', dark: 'dark' });
  });
});
