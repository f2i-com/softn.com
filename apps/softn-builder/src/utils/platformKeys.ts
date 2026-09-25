/**
 * The name of the command modifier on this machine. Every Builder shortcut
 * accepts Ctrl or ⌘ (the handlers test `ctrlKey || metaKey`), but telling a
 * Mac user to press Ctrl sends them to the wrong key.
 */
export function isApplePlatform(nav: Pick<Navigator, 'platform' | 'userAgent'> | undefined = globalThis.navigator): boolean {
  if (!nav) return false;
  return /Mac|iPhone|iPad|iPod/i.test(nav.platform || '') || /Mac OS X/i.test(nav.userAgent || '');
}

export function modKeyLabel(apple = isApplePlatform()): string {
  return apple ? '⌘' : 'Ctrl';
}

/**
 * A shortcut as a tooltip reads it: `withMod('S')` is "Ctrl+S" or "⌘S",
 * and `withMod('Shift+E')` is "Ctrl+Shift+E" or "⇧⌘E", as each platform writes them.
 */
export function withMod(key: string, apple = isApplePlatform()): string {
  if (!apple) return `Ctrl+${key}`;
  const shift = key.startsWith('Shift+');
  return `${shift ? '⇧' : ''}⌘${shift ? key.slice(6) : key}`;
}
