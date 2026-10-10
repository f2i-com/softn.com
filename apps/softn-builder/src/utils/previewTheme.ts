/**
 * What Preview hands the app's ThemeProvider: the project's theme as its
 * declaration, the way a runtime hands it over.
 *
 * Preview gave the project's side as `darkMode`, which is the provider's
 * input for an editor's own switch and beats everything, a page's pin
 * included. An app that has a light and dark switch of its own says so
 * through its page's `theme`, so once it was switched away from the
 * project's side it was previewed as nothing runs it: its page on one side,
 * its chart and code colours on the other.
 *
 * As `declaredMode` the project's side is the manifest's word in the rule
 * every host goes by (@softn/components, theme/app-theme.ts): light or dark
 * wins over the host and the device, a page that pins a side takes the
 * tokens with it, and "system" follows the host, which Preview is told to
 * read as the web runtime does: the document's theme (`followHost`: here
 * the site's theme, the editor's own), the stored preference, the device
 * (`followSystem`).
 *
 * No `box` is named. The provider writes its tokens on `:root` of the
 * document it is drawn in, and Preview draws the app in a frame of its own:
 * that root is the frame's, and the editor's document is not written on.
 */

import type { ThemeMode } from './themeMode';

export interface PreviewThemeProps {
  followHost: true;
  followSystem: true;
  declaredMode: ThemeMode;
}

export function previewThemeProps(themeMode: ThemeMode): PreviewThemeProps {
  return { followHost: true, followSystem: true, declaredMode: themeMode };
}
