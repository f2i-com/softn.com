/**
 * The context object that carries an app's scope, on its own.
 *
 * loader/app-scope.tsx owns the provider and the hooks that read the scope,
 * and it imports xdb.ts for the shared-store fallback. xdb.ts's own hooks —
 * useCollection and useRecord — must read the same context to find the store
 * of the app they are rendered in, and xdb.ts importing the loader back would
 * be a cycle. The context object needs nothing but React, so it lives here,
 * below both; the loader re-exports it and the types under the names it
 * always had.
 */

import React from 'react';
import type { XDBService } from './xdb';

/**
 * Turns a bundle-relative asset path into something the browser can load.
 * `pathOf` maps a URL the resolver minted back to the bundle path, for
 * loaders that are handed a URL and must resolve siblings against the
 * original location rather than an opaque blob; `dispose` releases whatever
 * the resolver minted.
 */
export interface AppAssetResolver {
  (path: string): string;
  pathOf?(url: string): string | undefined;
  dispose?(): void;
}

export interface AppScope {
  /** The app's identity; absent for a renderer that was given none. */
  appId?: string;
  /** The store this app's own logic reads and writes. */
  xdb: XDBService;
  /** Whether the host is showing this app: false for a background tab. */
  active: boolean;
  /** How this app's markup reaches the files in its bundle. */
  assets?: AppAssetResolver;
  /**
   * False where the app's manifest denies its script the clipboard. A
   * component that copies runs in the page, outside the sandbox that rule is
   * kept by, so it has to ask.
   */
  clipboard?: boolean;
  /**
   * Follow a link to another page of the app in place, as `<a
   * href="about.html">` written in the page is followed
   * (SoftNRenderContext.followLink): true when the host showed it, and the
   * browser is not to go there. Absent where the host shows no pages itself.
   */
  followLink?: (href: string) => boolean;
  /**
   * The page the app shows, by the name its state holds it under: its
   * `currentPage`, or the `page` Studio's projects keep. Absent when the app
   * keeps no such state.
   */
  currentPage?: string;
  /** Show the page of that name, by setting the state above: false when the app keeps none. */
  showPage?: (name: string) => boolean;
}

/**
 * Null below no provider: a component outside any app must fall back to the
 * shared default store, and the hooks decide that, not the context.
 */
export const AppScopeContext = React.createContext<AppScope | null>(null);
