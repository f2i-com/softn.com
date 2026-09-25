import { describe, expect, it } from 'vitest';
import { isApplePlatform, modKeyLabel, withMod } from './platformKeys';

describe('platform keys', () => {
  it('names the command key for the machine', () => {
    expect(isApplePlatform({ platform: 'MacIntel', userAgent: '' })).toBe(true);
    expect(isApplePlatform({ platform: 'iPad', userAgent: '' })).toBe(true);
    expect(isApplePlatform({ platform: '', userAgent: '' })).toBe(false);
    expect(isApplePlatform({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0)' })).toBe(false);
  });

  it('writes shortcuts the way each platform does', () => {
    expect(modKeyLabel(false)).toBe('Ctrl');
    expect(modKeyLabel(true)).toBe('⌘');
    expect(withMod('S', false)).toBe('Ctrl+S');
    expect(withMod('Shift+E', true)).toBe('⇧⌘E');
    expect(withMod('Shift+E', false)).toBe('Ctrl+Shift+E');
  });
});
