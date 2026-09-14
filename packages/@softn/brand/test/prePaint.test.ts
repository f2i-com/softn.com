/**
 * Every app that wears the product bar (and so its theme toggle) runs the
 * pre-paint script before its first paint, so a reader who chose light never
 * sees a dark flash. The script is kept here as text; each index.html carries
 * a copy, and this is what keeps the copies honest. The loader used to have
 * none and flashed dark on every desktop start.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRE_PAINT_SCRIPT, THEME_KEY } from '../src/theme';

const APPS_WITH_BAR = ['softn-site', 'softn-web', 'softn-builder', 'softn-studio', 'softn-loader'];

const normalise = (text: string) => text.replace(/\s+/g, ' ').trim();

describe('pre-paint theme script', () => {
  for (const app of APPS_WITH_BAR) {
    it(`${app}/index.html runs it before first paint`, () => {
      const html = readFileSync(resolve(import.meta.dirname, '../../../../apps', app, 'index.html'), 'utf8');
      const head = html.slice(0, html.indexOf('<body'));
      expect(head).toContain(`localStorage.getItem('${THEME_KEY}')`);
      expect(normalise(head)).toContain(normalise(PRE_PAINT_SCRIPT));
      expect(head).toContain('<meta name="theme-color"');
    });
  }
});
