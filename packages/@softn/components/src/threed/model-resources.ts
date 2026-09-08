/**
 * Where a model's bytes, and every byte it goes on to ask for, may come from.
 *
 * A `.gltf` is rarely one file: it names buffers and images by URI, and
 * three's loader fetches each of them through whatever LoadingManager it was
 * given. Scene3D used to give it none, so those fetches went through
 * `THREE.DefaultLoadingManager` — a page-wide singleton with no policy at
 * all. Two things went wrong. A bundle model whose URI was `textures/skin.png`
 * resolved against the blob: URL the host had minted for the .gltf and asked
 * the browser for `blob:https://host/textures/skin.png`, which does not
 * exist. And a remote model could name a buffer on any host it liked: the
 * scene had judged the .gltf's URL against the bundle's `net` grant and then
 * let the loader fetch the rest unjudged.
 *
 * Every load now gets a manager of its own, and its URL modifier decides
 * before a request is dispatched: a bundle model's relative URIs resolve
 * against the archive directory `pathOf` names and come back as the host's
 * own object URLs; anything else is judged with the same egress policy as
 * the model itself. A refusal returns `data:,`, which the loader "fetches"
 * without leaving the page and which fails to parse, so the model fails
 * closed — and the refusal is recorded so the failure can say why.
 *
 * The manager is per load rather than per module because a shared one is
 * the "whichever app rendered last" bug in another costume: two apps in one
 * realm would take turns overwriting its modifier while their loads were in
 * flight. Nothing here touches three's global manager.
 *
 * The policy is read at each decision, not captured when the load begins.
 * A scene builds a new policy whenever its capability state changes — a
 * consent answered, most of all — and a model whose bytes were still on
 * their way when the user allowed `net` should get its textures, not keep
 * refusing them by the policy of a moment ago. The other direction holds
 * too: a URL judged while consent was pending was refused, not requested,
 * so nothing left the page before the user answered.
 */

import * as THREE from 'three';
import { isSafeUrl, type AppAssetResolver } from '@softn/core';

/** The answer for one URL, in the shape core's egress judges give. */
export type UrlVerdict = { allowed: true } | { allowed: false; reason: string };

export interface ModelResourcePolicy {
  /** The scene's egress judge: the decision made for the model URL, reused for its parts. */
  judge: (url: string) => UrlVerdict;
  /** The host's bundle resolver, when the scene is inside an app that has one. */
  assets?: AppAssetResolver;
}

/**
 * A policy, or a getter for the policy of the moment. A load in flight is
 * given the getter, so each URL the loader asks about is judged by the
 * policy current when it asks.
 */
export type ModelResourcePolicySource = ModelResourcePolicy | (() => ModelResourcePolicy);

function policyReader(source: ModelResourcePolicySource): () => ModelResourcePolicy {
  return typeof source === 'function' ? source : () => source;
}

/**
 * A URL that yields nothing without a request. `fetch('data:,')` resolves
 * to an empty body in every browser, so a refused subresource costs no
 * round trip and cannot be told apart from a missing file by anyone
 * watching the network.
 */
export const NO_REQUEST_URL = 'data:,';

export interface ResourceRefusal {
  url: string;
  reason: string;
}

/** What one model load carries: its manager, its base, and what it was refused. */
export interface LoadResources {
  manager: THREE.LoadingManager;
  /**
   * What the loader prefixes relative URIs with. Empty for a bundle model,
   * so URIs reach the modifier as written and can be resolved against the
   * archive; the model URL's own directory otherwise, which is what three
   * would have used.
   */
  resourcePath: string;
  /** The model's path inside its bundle, when it came from one. */
  bundlePath?: string;
  refused: ResourceRefusal[];
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Whether a URI names its own origin, as opposed to being relative to the model. */
function isAbsolute(uri: string): boolean {
  return SCHEME.test(uri) || uri.startsWith('//');
}

/**
 * The archive path a URI relative to `baseDir` names, or null when it
 * climbs out of the bundle. glTF URIs are percent-encoded relative
 * references, so `my%20skin.png` is `my skin.png`; a leading slash is taken
 * as the bundle root, since there is nothing above it to be relative to.
 */
export function resolveBundleRelative(baseDir: string, uri: string): string | null {
  const bare = uri.split('#')[0].split('?')[0];
  if (bare === '') return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    return null;
  }
  decoded = decoded.replace(/\\/g, '/');
  const segments = decoded.startsWith('/') ? [] : baseDir.split('/').filter(Boolean);
  for (const part of decoded.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.length > 0 ? segments.join('/') : null;
}

/** The directory part of an archive path: `models/hero/hero.gltf` → `models/hero`. */
function archiveDirectory(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

/**
 * A manager for one load of `url`, whose modifier authorises every URL the
 * loader asks for. The top-level URL passes untouched: the scene judged it
 * before the load began. The bundle the model is in is fixed for the load;
 * the judge is read from `source` at each decision.
 */
export function createLoadResources(url: string, source: ModelResourcePolicySource): LoadResources {
  const policy = policyReader(source);
  const assets = policy().assets;
  const bundlePath = assets?.pathOf?.(url);
  const baseDir = bundlePath === undefined ? '' : archiveDirectory(bundlePath);
  const refused: ResourceRefusal[] = [];
  const refuse = (requested: string, reason: string): string => {
    refused.push({ url: requested, reason });
    return NO_REQUEST_URL;
  };

  const manager = new THREE.LoadingManager();
  manager.setURLModifier((requested: string): string => {
    if (requested === url) return url;
    if (bundlePath !== undefined && assets && !isAbsolute(requested)) {
      const path = resolveBundleRelative(baseDir, requested);
      if (path === null) return refuse(requested, 'resolves outside the bundle');
      const minted = assets(path);
      return minted || refuse(requested, `the bundle has no file "${path}"`);
    }
    // An embedded buffer or image (`data:application/octet-stream;base64,…`)
    // never leaves the page, and is not an image the DOM scheme check would
    // pass, so it is allowed on its own terms; everything with a scheme the
    // page could be sent to is held to the DOM's list first.
    if (!requested.startsWith('data:') && !isSafeUrl(requested)) {
      return refuse(requested, 'unsupported URL scheme');
    }
    const verdict = policy().judge(requested);
    return verdict.allowed ? requested : refuse(requested, verdict.reason);
  });

  const resourcePath = bundlePath !== undefined ? '' : THREE.LoaderUtils.extractUrlBase(url);
  return { manager, resourcePath, bundlePath, refused };
}

/**
 * An image texture named by `textureUrl`, fetched through a manager of its
 * own. It has no subresources, so this is the same policy applied for
 * uniformity's sake: the URL has already been judged, and the load is
 * handed to three exactly the way a model's images are.
 */
export function loadTextureThrough(
  url: string,
  policy: ModelResourcePolicySource,
  repeat?: { x: number; y: number }
): THREE.Texture | null {
  if (!isSafeUrl(url)) return null;
  const resources = createLoadResources(url, policy);
  try {
    const texture = new THREE.TextureLoader(resources.manager).load(url);
    if (repeat) {
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(repeat.x, repeat.y);
    }
    return texture;
  } catch {
    return null;
  }
}
