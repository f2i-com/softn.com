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
}

/**
 * Null below no provider: a component outside any app must fall back to the
 * shared default store, and the hooks decide that, not the context.
 */
export const AppScopeContext = React.createContext<AppScope | null>(null);
