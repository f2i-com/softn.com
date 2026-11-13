/**
 * A file of the app's own, named by its path from logic.
 *
 * `asset("assets/hero.glb")` exists only in markup: it is the host's
 * function, and logic is not given it. A game builds its objects, its sprites
 * and its maps in logic, so the only name it has for a file in its bundle is
 * the path, and a path handed to the browser as it stands is read against the
 * page's address, where the host has no such file. `softn.audio.play` has
 * always taken a bundle path and asked the host's resolver about it; a
 * component that is handed a source does the same here.
 *
 * Only a source with no scheme is offered, and one the resolver does not know
 * is left as written, so a deployment that serves its files beside the page
 * still shows them. What comes back is the host's own URL for the file. It is
 * still the caller's to judge: the resolver is the host's, and a host may
 * answer with an address on the network.
 */

import { useMemo } from 'react';
import {
  describeMarkupEgress,
  useAppAssets,
  useEgressConfig,
  type AppAssetResolver,
} from '@softn/core';

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Whether `written` could name a file in the bundle: text with no scheme
 * (`https:`, `blob:`, `data:`), not an address on another host written
 * without one (`//host/x`, or the same with backslashes, which the browser
 * reads alike), and not a fragment.
 */
export function namesBundleFile(written: unknown): written is string {
  if (typeof written !== 'string') return false;
  const text = written.trim().replace(/\\/g, '/');
  return text !== '' && !SCHEME.test(text) && !text.startsWith('//') && !text.startsWith('#');
}

/**
 * `written` as the host's URL for that file of the bundle, or `written`
 * itself when it names no bundle file, there is no resolver, or the resolver
 * does not know the path. Never throws: a resolver that does is one that does
 * not know.
 */
export function resolveBundleSrc<T>(written: T, assets: AppAssetResolver | undefined): T | string {
  if (!assets || !namesBundleFile(written)) return written;
  let url: unknown;
  try {
    url = assets(written);
  } catch {
    return written;
  }
  return typeof url === 'string' && url !== '' ? url : written;
}

/**
 * A component's `src` as it should be loaded: the bundle's file when the
 * source names one by path, the source as written otherwise.
 *
 * The renderer has already judged the source as written against the app's
 * permissions. What the resolver answers with is judged here by the same
 * policy, and withheld (undefined) when it is refused: a path must not turn
 * into a fetch the app was not allowed by way of the resolver.
 */
export function useBundleSrc(src: string | undefined): string | undefined {
  const assets = useAppAssets();
  const egress = useEgressConfig();
  return useMemo(() => {
    const url = resolveBundleSrc(src, assets);
    if (url === src || typeof url !== 'string') return src;
    return describeMarkupEgress(url, egress).allowed ? url : undefined;
  }, [src, assets, egress]);
}
