/**
 * The error card's buttons follow its words.
 *
 * `describeFailure` (@softn/runtime-shell) writes the words; `failureActions`
 * decides which buttons stand beside them. They read the same message by
 * rules of their own, so this holds one to the other: a failure the card
 * tells the person to try again has "Try again", one it sends to the
 * directory has the directory, and nothing else has either.
 */

import { describe, expect, it } from 'vitest';
import { describeFailure } from '@softn/runtime-shell/failure';
import { failureActions } from '../src/lib/failureActions';

const DOWNLOAD = 'The app couldn’t be downloaded';
const NOT_FOUND = 'This app wasn’t found';
const DAMAGED = 'This isn’t a readable .softn file';

describe('what the error card offers', () => {
  it.each([
    ['Failed to fetch', DOWNLOAD],
    ['NetworkError when attempting to fetch resource.', DOWNLOAD],
    ['Load failed', DOWNLOAD],
    ['Could not fetch /api/apps/notes/bundle.softn (HTTP 503 Service Unavailable).', DOWNLOAD],
    ['Invalid ZIP: missing end-of-central-directory', DAMAGED],
  ])('offers to try again after "%s"', (message, title) => {
    expect(describeFailure(new Error(message)).title).toBe(title);
    expect(failureActions(new Error(message))).toEqual({ retry: true, browse: false });
  });

  it.each([
    ['Could not fetch /api/apps/no-such-app/bundle.softn (HTTP 404 Not Found).'],
    ['Could not fetch /api/apps/gone/bundle.softn (HTTP 410 Gone).'],
    ['/demos/Nope.softn is not a bundle — the server returned a web page.'],
  ])('sends "%s" to the directory, and does not offer the same address again', (message) => {
    expect(describeFailure(new Error(message)).title).toBe(NOT_FOUND);
    expect(failureActions(new Error(message))).toEqual({ retry: false, browse: true });
  });

  it.each([
    // Refusals: asking again gets the same answer.
    ['Refusing /x.softn: it redirected to https://elsewhere.example, which is not this site.'],
    ['/demos/Big.softn is larger than the 32 MB limit for bundles opened by URL.'],
    ['Encrypted bundles are not supported'],
    ['Invalid manifest.json: names no entry file'],
    // Not an open at all, though their words hold the ones a download's failure has.
    ['Nothing was imported: the file is corrupt.'],
    ['Nothing was changed. Failed to fetch'],
    ['“Notes” is not saved in this browser'],
    ['Stop “Notes” first'],
    ['something nobody expected'],
  ])('offers neither after "%s"', (message) => {
    expect(failureActions(new Error(message))).toEqual({ retry: false, browse: false });
    const title = describeFailure(new Error(message)).title;
    expect(title).not.toBe(DOWNLOAD);
    expect(title).not.toBe(NOT_FOUND);
    expect(title).not.toBe(DAMAGED);
  });

  it('reads a thrown string and survives a thrown nothing', () => {
    expect(failureActions('Failed to fetch')).toEqual({ retry: true, browse: false });
    expect(failureActions(undefined)).toEqual({ retry: false, browse: false });
  });
});
