/**
 * The agent is told where an app's theme is kept, and where its seed records go.
 *
 * A runtime draws an app on the side its project declares: manifest.json's
 * `config.theme.mode`, unless the page pins light or dark with `<App theme>`.
 * Studio writes both into every new app, and the guide named only the page's.
 * An agent asked for a light app changed the page and left the manifest
 * saying dark, which was harmless while no runtime read it; one asked to
 * "follow the device" took `theme` off `<App>`, which now leaves the app on
 * the manifest's side for every visitor. The guide names both and says to
 * move them together.
 *
 * It also said seed records live in `data/*.xdb`, beside a scaffold that
 * writes them to `xdb/`, so a second collection went into a second folder.
 */

import { describe, expect, it } from 'vitest';
import { buildGuide } from '../src/lib/agent/guide';
import { generateBlueprintFromBrief, scaffoldProjectFiles } from '../src/lib/studioProject';
import type { ProjectBrief } from '../src/types/studio';

const STYLES: ProjectBrief['style'][] = ['clean', 'bold', 'minimal', 'playful', 'dark'];
const brief = (style: ProjectBrief['style']): ProjectBrief => ({
  appName: 'Notes', description: 'Notes.', target: 'web', pages: ['Home'], collections: ['Notes'], authNeeded: false, style, referenceImages: [], logicLanguage: 'javascript',
});

describe('the guide, on an app’s theme', () => {
  it('names the manifest’s mode beside the page’s theme, which one wins, and to change them together', () => {
    for (const python of [false, true]) {
      const guide = buildGuide({ python, torch: false, style: 'clean' });
      expect(guide).toContain('`config.theme.mode`');
      expect(guide).toMatch(/`<App theme="light">` or `<App theme="dark">` pins the page to that side wherever it runs/);
      expect(guide).toMatch(/a page that pins neither is drawn on the side `config\.theme\.mode` declares/);
      // What the running app does with each: the manifest's side over the visitor and the site,
      // the page's pin over the manifest, and "system" for following the visitor.
      expect(guide).toMatch(/wins over the visitor's device and the theme of the site it is opened on/);
      expect(guide).toMatch(/`"system"` \(or no mode\) follows the visitor/);
      expect(guide).toMatch(/wins over the manifest/);
      expect(guide).toMatch(/change both/);
      // How to follow the visitor's device, which is neither of the two alone.
      expect(guide).toMatch(/`"system"` in the manifest and no `theme` on `<App>`/);
    }
  });

  it('describes what the scaffold writes: the same side in the manifest and on the page, for every style', () => {
    for (const style of STYLES) {
      const files = new Map(scaffoldProjectFiles(brief(style), generateBlueprintFromBrief(brief(style))).map((f) => [f.path, f.content]));
      const mode = (JSON.parse(files.get('manifest.json')!) as { config: { theme: { mode: string } } }).config.theme.mode;
      expect(['light', 'dark']).toContain(mode);
      expect(files.get('ui/main.ui'), style).toContain(`<App theme="${mode}">`);
    }
  });
});

describe('the guide, on where seed records go', () => {
  it('names the folder the scaffold writes them to', () => {
    const scaffolded = scaffoldProjectFiles(brief('clean'), generateBlueprintFromBrief(brief('clean'))).map((f) => f.path).filter((path) => path.endsWith('.xdb'));
    expect(scaffolded).toEqual(['xdb/notes.xdb']);
    for (const python of [false, true]) {
      const guide = buildGuide({ python, torch: false, style: 'clean' });
      expect(guide).toContain('**xdb/*.xdb** — seed records');
      expect(guide).not.toContain('data/*.xdb');
    }
  });
});
