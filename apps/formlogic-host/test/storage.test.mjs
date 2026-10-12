// node --test apps/formlogic-host/test/storage.test.mjs
// (Node 24 runs the TypeScript module directly; it uses only erasable syntax.)
//
// The alert a failed save of the app's browser session shows. It was drawn in
// fixed light colours, a pale orange page with dark orange text, whatever the
// side the app is drawn in: a light strip across a dark app. It takes the
// theme's colours now: the provider writes them on this frame's document,
// which is one app's whole document (see appTheme.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_ALERT_STYLE } from '../src/storage.ts';

test('the storage alert is drawn in the theme the app is drawn in', () => {
  assert.equal(typeof STORAGE_ALERT_STYLE, 'string');
  assert.match(STORAGE_ALERT_STYLE, /color:\s*var\(--color-text\b/);
  assert.match(STORAGE_ALERT_STYLE, /background:[^;]*var\(--color-surface\b/);
  assert.match(STORAGE_ALERT_STYLE, /var\(--color-warning-500\b/, 'still marked as a warning');
  assert.doesNotMatch(STORAGE_ALERT_STYLE, /#fff7ed|#9a3412/i, 'no fixed light colours');
});
