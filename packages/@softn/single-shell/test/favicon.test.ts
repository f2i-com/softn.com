// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { installFavicon } from '../src/favicon';
it('updates the site icon without creating duplicates and restores the initial icon on cleanup', () => {
  const initial = document.createElement('link');
  initial.id = 'application-icon';
  initial.rel = 'icon';
  initial.href = 'data:,';
  document.head.append(initial);
  const icon = 'data:image/svg+xml;base64,PHN2Zy8+';
  const restore = installFavicon(icon);
  expect(initial.href).toBe(icon);
  expect(document.head.querySelectorAll('link[rel="icon"]')).toHaveLength(1);
  restore();
  expect(initial.href).toBe('data:,');
  initial.remove();
});
it('keeps an unbranded fallback without requesting a root favicon when the app has no icon', () => {
  const restore = installFavicon();
  expect(document.querySelector<HTMLLinkElement>('#application-icon')?.href).toMatch(
    /^data:image\/svg\+xml,/
  );
  restore();
  expect(document.querySelector('#application-icon')).toBeNull();
});
