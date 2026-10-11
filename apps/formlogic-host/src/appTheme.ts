// The side an embedded app is drawn in.
//
// The rule is the one every host shares (@softn/components/theme,
// app-theme.ts): a project that declares "light" or "dark" in its manifest is
// drawn in that side, a page's own `<App theme>` still wins, and "system" or
// nothing follows the host. Here the host is FormLogic, which says which side
// it is in with `init.dark`.
//
// This frame is one app's whole document, so the side is written where the
// theme provider has always written it, on the document: the tokens, and with
// them the body's ground and text colour. No box of the app's own is named,
// as the hosts that draw an app inside a page of theirs name one, because
// there is nothing of FormLogic's in this document to keep on its side.

/**
 * The manifest's `config.theme.mode`, handed over as it stands: which values
 * decide anything is the rule's to say. Undefined for a manifest that
 * declares none or is not shaped like one.
 */
export function declaredThemeMode(manifest: unknown): unknown {
  const config = manifest !== null && typeof manifest === 'object' ? (manifest as { config?: unknown }).config : undefined;
  const theme = config !== null && typeof config === 'object' ? (config as { theme?: unknown }).theme : undefined;
  return theme !== null && typeof theme === 'object' ? (theme as { mode?: unknown }).mode : undefined;
}
