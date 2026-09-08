/**
 * The app a component belongs to, as React context.
 *
 * A component several levels below the renderer — `<SmartForm collection="…">`
 * is the usual one — has no appId prop and no way to be handed one: the
 * document renderer instantiates it from a .ui template, so the host would
 * have to thread the id through every component in the registry. Its store
 * used to come from a module-level pointer that SoftNRenderer set during
 * render, and that pointer said which app had rendered most recently, not
 * which app the component was in. softn-web keeps every open tab mounted in
 * one realm and toggles them with `display`, so the two were routinely
 * different: any re-render of tab B repointed the global, and a handler in
 * tab A that had already yielded — SmartForm's submit awaited a dynamic import
 * before it looked the store up — resumed and wrote A's record into B's
 * store. No error, and A never saw the record it had just saved.
 *
 * Context is per tree, which is the property that was missing. Each renderer
 * publishes its own scope; a component reads it with a hook, at render time,
 * and the value it captured is the one its callbacks use however long they
 * suspend. Nothing outside the tree can change it in between.
 *
 * The default — no provider above — is the shared `_default` store, active,
 * with no asset resolver. A component used outside any app (the builder's
 * palette, studio's preview, a host importing @softn/components directly)
 * must never land in some other app's store; now that no renderer moves the
 * module-level pointer, the no-argument lookup is exactly that store.
 */

import React from 'react';
import { getXDB, type XDBService } from '../runtime/xdb';
import {
  AppScopeContext,
  type AppAssetResolver,
  type AppScope,
} from '../runtime/app-scope-context';

// The context object and its types live in the runtime, below xdb.ts, so that
// useCollection and useRecord can read the scope without importing the loader
// back into the module the loader imports. This is still where they are
// published from.
export { AppScopeContext };
export type { AppAssetResolver, AppScope };

export function AppScopeProvider(props: {
  value: AppScope;
  children: React.ReactNode;
}): React.ReactElement {
  return <AppScopeContext.Provider value={props.value}>{props.children}</AppScopeContext.Provider>;
}

export function useAppScope(): AppScope {
  const scope = React.useContext(AppScopeContext);
  // Resolved per call rather than cached at module load: the shared store does
  // not exist until something asks for it, and a host may swap it with
  // setDefaultXDB(). getXDB() memoises the instance, so the object below is
  // stable for as long as that instance is.
  const fallback = scope ? null : getXDB();
  return React.useMemo(
    () => scope ?? { xdb: fallback as XDBService, active: true },
    [scope, fallback]
  );
}

export function useAppXDB(): XDBService {
  return useAppScope().xdb;
}

export function useAppActive(): boolean {
  return useAppScope().active;
}

export function useAppAssets(): AppAssetResolver | undefined {
  return useAppScope().assets;
}
