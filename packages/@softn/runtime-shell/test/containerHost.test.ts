/**
 * What every SoftN host mounts a container with, as far as it depends on the page the host
 * is: a browser's page shows an app's frames (a video player of a site the person allowed),
 * a desktop shell's page is kept to its own files and is told to make none.
 */
import { describe, expect, it } from 'vitest';
import { hostedContainerOptions, pageShowsFrames } from '../src/containerHost';

describe('whether a host’s page shows an app’s frames', () => {
  it('does in a browser', () => {
    expect(pageShowsFrames({ location: { protocol: 'https:', hostname: 'softn.com' } })).toBe(true);
    expect(pageShowsFrames({ location: { protocol: 'http:', hostname: 'localhost' } })).toBe(true);
  });

  it('does not in a desktop shell, whose policy names no frame-src', () => {
    expect(pageShowsFrames({ location: { protocol: 'tauri:', hostname: 'localhost' } })).toBe(false);
    expect(pageShowsFrames({ location: { protocol: 'http:', hostname: 'tauri.localhost' } })).toBe(false);
    expect(pageShowsFrames({ __TAURI_INTERNALS__: {}, location: { protocol: 'https:', hostname: 'softn.com' } })).toBe(false);
    expect(pageShowsFrames({ __TAURI__: { core: {} }, location: { protocol: 'https:', hostname: 'softn.com' } })).toBe(false);
  });

  it('does not where there is no page at all', () => {
    expect(pageShowsFrames(undefined)).toBe(false);
  });

  it('is said in the options every host mounts with', () => {
    expect(hostedContainerOptions({ BASE_URL: '/' }).frames).toBe(pageShowsFrames() ? 'allow' : 'deny');
  });
});
