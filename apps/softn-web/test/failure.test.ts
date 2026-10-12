/**
 * The error card says what went wrong and what to do, and keeps the thrower's
 * own words as the detail an author needs.
 */
import { describe, expect, it } from 'vitest';
import { describeFailure } from '../src/lib/failure';

describe('describeFailure', () => {
  it('names a broken manifest and says how to get a working copy', () => {
    const view = describeFailure(new Error('Invalid manifest.json: The manifest.json is not valid JSON.'));
    expect(view.title).toBe('This app’s manifest is broken');
    expect(view.hint).toMatch(/Studio or Builder/);
    expect(view.detail).toBe('The manifest.json is not valid JSON.');
    expect(view.offerAnotherFile).toBe(true);
  });

  it('turns an archive error into a damaged-file message, keeping the reason', () => {
    const view = describeFailure(new Error('Invalid ZIP: missing end-of-central-directory'));
    expect(view.title).toBe('This isn’t a readable .softn file');
    expect(view.hint).toMatch(/damaged or only partly downloaded/);
    expect(view.detail).toContain('end-of-central-directory');
  });

  it('says an archive of a kind the reader does not open is one, not that something went wrong', () => {
    // Neither message says "corrupt" or "ZIP:" in the words the damaged-file
    // rule looked for, so a password-protected or ZIP64 archive fell through
    // to the catch-all with nothing to do about it.
    for (const message of ['Encrypted bundles are not supported', 'ZIP64 bundles are not supported']) {
      const view = describeFailure(new Error(message));
      expect(view.title, message).toBe('This kind of archive can’t be opened');
      expect(view.hint, message).toMatch(/Export the app again from Studio or Builder/);
      expect(view.detail, message).toBe(message);
      expect(view.offerAnotherFile, message).toBe(true);
    }
  });

  it('points an undeclared Python package at its author', () => {
    const view = describeFailure(
      new Error('logic/main.py imports torch, which an app asks for in manifest.json: "config": { "python": { "packages": ["torch"] } }'),
    );
    expect(view.title).toBe('This app uses a Python package it doesn’t declare');
    expect(view.detail).toContain('imports torch');
  });

  it('treats a failed download as a connection problem, not a bad file', () => {
    const view = describeFailure(new Error('Could not fetch /api/apps/x/bundle.softn (HTTP 503 Service Unavailable).'));
    expect(view.title).toBe('The app couldn’t be downloaded');
    expect(view.offerAnotherFile).toBe(false);
  });

  it('falls back to a plain title and the message', () => {
    const view = describeFailure(new Error('Something odd'));
    expect(view).toEqual({ title: 'Something went wrong', detail: 'Something odd', offerAnotherFile: false });
  });
});
