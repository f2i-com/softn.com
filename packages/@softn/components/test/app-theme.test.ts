/**
 * Which side an app is drawn in is one rule, asked by every host: the web
 * runtime, the desktop loader, the single-app shells and the editors'
 * previews. A project's manifest can declare light or dark, and for a long
 * time no runtime read it: Builder wrote the choice, drew it on its canvas
 * and in its Preview, and a visitor on a light device then saw a project
 * declared dark in light tokens. The rule is held here as a table, so a host
 * cannot grow a reading of its own.
 */
import { describe, expect, it } from 'vitest';
import { resolveAppTheme, type AppThemeInputs, type ThemeSide } from '../src/theme/app-theme';

type Row = [name: string, inputs: AppThemeInputs, tokens: ThemeSide, page: ThemeSide, decidedBy: string];

const rows: Row[] = [
  // The manifest's light or dark wins over the host's theme, the stored
  // preference and the device, in whatever combination they disagree.
  ['a project declared dark is dark on a light device', { manifest: 'dark', device: 'light', fallback: 'light' }, 'dark', 'dark', 'manifest'],
  ['a project declared light is light on a dark device', { manifest: 'light', device: 'dark', fallback: 'dark' }, 'light', 'light', 'manifest'],
  ['a project declared dark is dark where the host page is light', { manifest: 'dark', host: 'light', device: 'light', fallback: 'light' }, 'dark', 'dark', 'manifest'],
  ['a project declared light is light where the host page is dark', { manifest: 'light', host: 'dark', stored: 'dark', device: 'dark', fallback: 'dark' }, 'light', 'light', 'manifest'],
  ['a project declared dark is dark over a stored light preference', { manifest: 'dark', stored: 'light', fallback: 'light' }, 'dark', 'dark', 'manifest'],
  ['a project declared light is light where the deployment is configured dark', { manifest: 'light', fallback: 'dark' }, 'light', 'light', 'manifest'],

  // A page's own `<App theme>` keeps winning for the page, and the tokens go
  // with it: a page pinned light in a project declared dark must not be a
  // light page drawn with the dark set's chart and code colours.
  ['a page pinned light in a project declared dark is light, tokens and page', { manifest: 'dark', page: 'light', device: 'dark', fallback: 'dark' }, 'light', 'light', 'page'],
  ['a page pinned dark in a project declared light is dark, tokens and page', { manifest: 'light', page: 'dark', host: 'light', fallback: 'light' }, 'dark', 'dark', 'page'],
  ['a page pinned the way its project is declared is that side', { manifest: 'dark', page: 'dark', host: 'light', device: 'light', fallback: 'light' }, 'dark', 'dark', 'page'],
  ['a page whose theme is not light or dark leaves the project to decide', { manifest: 'dark', page: 'system', device: 'light', fallback: 'light' }, 'dark', 'dark', 'manifest'],
  ['a page with a named theme of its own leaves the project to decide the side', { manifest: 'light', page: 'ocean', device: 'dark', fallback: 'dark' }, 'light', 'light', 'manifest'],

  // No mode, or "system": exactly what it was. The host's theme, then the
  // stored preference, then the device, then the host's default; and a pinned
  // page is its own side over tokens that go on following the host.
  ['a project that declares nothing follows the host page', { host: 'dark', stored: 'light', device: 'light', fallback: 'light' }, 'dark', 'dark', 'host'],
  ['a project declared system follows the host page', { manifest: 'system', host: 'light', stored: 'dark', device: 'dark', fallback: 'dark' }, 'light', 'light', 'host'],
  ['with no host theme, a project declared system follows the stored preference', { manifest: 'system', stored: 'dark', device: 'light', fallback: 'light' }, 'dark', 'dark', 'stored'],
  ['with neither, a project declared system follows the device', { manifest: 'system', device: 'dark', fallback: 'light' }, 'dark', 'dark', 'device'],
  ['with nothing to follow, the host default stands', { manifest: 'system', fallback: 'dark' }, 'dark', 'dark', 'fallback'],
  ['with nothing at all, light', {}, 'light', 'light', 'fallback'],
  ['a pinned page in a project declared system keeps the host tokens it always had', { manifest: 'system', page: 'dark', host: 'light', fallback: 'light' }, 'light', 'dark', 'host'],
  ['a pinned page in a project that declares nothing keeps the device tokens it always had', { page: 'light', device: 'dark', fallback: 'light' }, 'dark', 'light', 'device'],

  // A manifest is a file anyone can write: only the two words decide.
  ['a mode that is not one of the words decides nothing', { manifest: 'DARK', device: 'light', fallback: 'light' }, 'light', 'light', 'device'],
  ['a mode that is not text decides nothing', { manifest: { mode: 'dark' }, host: 'light', fallback: 'dark' }, 'light', 'light', 'host'],
  ['a host theme that is not light or dark is not followed', { host: 'sepia', device: 'dark', fallback: 'light' }, 'dark', 'dark', 'device'],

  // An editor's preview switch is the editor's, not a runtime's: it decides
  // outright, as it did, and a pinned page is still its own side under it.
  ['an editor preview set to light shows a project declared dark in light', { control: 'light', manifest: 'dark', device: 'dark', fallback: 'dark' }, 'light', 'light', 'control'],
  ['an editor preview set to dark leaves a page pinned light a light page', { control: 'dark', manifest: 'light', page: 'light', fallback: 'light' }, 'dark', 'light', 'control'],
];

describe('the side an app is drawn in', () => {
  it.each(rows)('%s', (_name, inputs, tokens, page, decidedBy) => {
    expect(resolveAppTheme(inputs)).toMatchObject({ tokens, page, decidedBy });
  });

  it('says what the host alone would have chosen, whatever the project declares', () => {
    // A host that draws several apps in one document keeps its own side on
    // the document and gives a declared app its side on the app's own box, so
    // it needs both answers from the one rule.
    expect(resolveAppTheme({ manifest: 'dark', host: 'light', fallback: 'light' })).toMatchObject({ tokens: 'dark', ambient: 'light' });
    expect(resolveAppTheme({ manifest: 'dark', page: 'light', device: 'dark', fallback: 'light' })).toMatchObject({ tokens: 'light', ambient: 'dark' });
    expect(resolveAppTheme({ manifest: 'system', stored: 'dark', fallback: 'light' })).toMatchObject({ tokens: 'dark', ambient: 'dark' });
  });
});

/**
 * What the ThemeProvider did before it knew of a manifest, kept word for
 * word: the host document's theme where it is followed, then the stored
 * preference, then the device where it is followed, then the default.
 */
function before(options: {
  followHost: boolean;
  followSystem: boolean;
  hostTheme: string | null;
  stored: string | null;
  deviceDark: boolean | undefined;
  defaultDarkMode: boolean;
}): boolean {
  if (options.followHost) {
    if (options.hostTheme === 'dark' || options.hostTheme === 'light') return options.hostTheme === 'dark';
  }
  if (options.stored === 'dark') return true;
  if (options.stored === 'light') return false;
  if (options.followSystem) return options.deviceDark ?? options.defaultDarkMode;
  return options.defaultDarkMode;
}

describe('a project that declares no side', () => {
  it('is drawn exactly as it was in every host, for every combination a host can be in', () => {
    const cases: string[] = [];
    for (const manifest of [undefined, 'system', '', null, 'auto']) {
      for (const followHost of [true, false]) {
        for (const followSystem of [true, false]) {
          for (const hostTheme of [null, 'light', 'dark', 'sepia']) {
            for (const stored of [null, 'light', 'dark', 'system']) {
              for (const deviceDark of [undefined, true, false]) {
                for (const defaultDarkMode of [true, false]) {
                  for (const page of [undefined, 'light', 'dark', 'system']) {
                    const was = before({ followHost, followSystem, hostTheme, stored, deviceDark, defaultDarkMode }) ? 'dark' : 'light';
                    const now = resolveAppTheme({
                      manifest,
                      page,
                      host: followHost ? hostTheme : undefined,
                      stored,
                      device: followSystem && deviceDark !== undefined ? (deviceDark ? 'dark' : 'light') : undefined,
                      fallback: defaultDarkMode ? 'dark' : 'light',
                    });
                    const pageWas = page === 'light' || page === 'dark' ? page : was;
                    if (now.tokens !== was || now.page !== pageWas || now.ambient !== was) {
                      cases.push(JSON.stringify({ manifest, followHost, followSystem, hostTheme, stored, deviceDark, defaultDarkMode, page, was, now }));
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(cases).toEqual([]);
  });
});
