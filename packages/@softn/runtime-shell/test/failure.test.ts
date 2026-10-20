/**
 * The error card says what went wrong and what to do, and keeps the thrower's
 * own words as the detail an author needs.
 */
import { describe, expect, it } from 'vitest';
import { describeFailure } from '../src/failure';

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

  it('says an app that is not there was not found, rather than blaming the connection', () => {
    // `/web/app/NoSuchApp` and `?open=/demos/Nope.softn` both end in a 404.
    for (const message of ['Could not fetch /api/apps/NoSuchApp/bundle.softn (HTTP 404 Not Found).', 'Could not fetch /demos/Nope.softn (HTTP 404 Not Found).']) {
      const view = describeFailure(new Error(message));
      expect(view.title, message).toBe('This app wasn’t found');
      expect(view.hint, message).not.toMatch(/connection/);
      expect(view.detail).toBe(message);
    }
  });

  it('says the same when a host answers a missing app with its own page', () => {
    // The dev server and most static hosts send their index.html, with a 200,
    // for an address they have nothing at.
    const view = describeFailure(new Error('/demos/Nope.softn is not a bundle — the server returned a web page.'));
    expect(view.title).toBe('This app wasn’t found');
    expect(view.hint).toMatch(/sent back a web page/);
    expect(view.hint).not.toMatch(/Only a \.softn app/);
  });

  it('names a refused link for what it is', () => {
    expect(describeFailure(new Error('Refusing to open "/index.html": only .softn bundles can be opened by URL.')).title).toBe('That address isn’t a .softn file');
    expect(describeFailure(new Error('Refusing to open a bundle from https://example.com: only bundles served from this site can be opened by URL.')).title).toBe(
      'Only apps from this site open from a link'
    );
    expect(describeFailure(new Error('Refusing /a.softn: it redirected to https://evil.example, which is not this site.')).title).toBe(
      'Only apps from this site open from a link'
    );
    expect(describeFailure(new Error('Refusing to open a javascript: URL: only bundles served over http or https can be opened by URL.')).title).toBe(
      'That link can’t open an app'
    );
    expect(describeFailure(new Error('Cannot open "%%": it is not a valid path.')).title).toBe('That link can’t open an app');
  });

  it('falls back to a plain title and the message', () => {
    const view = describeFailure(new Error('Something odd'));
    expect(view).toEqual({ title: 'Something went wrong', detail: 'Something odd', offerAnotherFile: false });
  });

  it('reads a thrown string, and gives no detail for something with no message', () => {
    expect(describeFailure('plain text').detail).toBe('plain text');
    expect(describeFailure({}).detail).toBe('');
    expect(describeFailure(undefined)).toEqual({ title: 'Something went wrong', detail: '', offerAnotherFile: false });
  });
});
