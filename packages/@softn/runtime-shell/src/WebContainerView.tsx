import React, { useEffect, useRef, useState } from 'react';
import type { Capability } from '@softn/bundle-format/capabilities';
import type { PermissionConfig } from '@softn/core';
import type { ContainerBootStatus, ContainerPermissions, SoftNContainerHandle } from '@softn/container';
import { hostedContainerOptions } from './containerHost';

export interface WebContainerViewProps {
  /** Raw `.softn`/`.zip` archive bytes or unpacked VFS map. */
  source: Uint8Array | Record<string, string | Uint8Array>;
  /** Where `@softn/container`'s runtime files are, when not where this build put them (containerHost.ts). */
  runtimeUrl?: string;
  /** Content-addressed identity for isolated container storage. */
  appId: string;
  /** The host's own key prefix for this app's kept data, when it keeps each app's data under one it manages. */
  storagePrefix?: string;
  /** Optional initial HTML page to navigate to inside the archive. */
  initialPage?: string;
  /** Optional initial virtual URL path to boot directly onto (e.g. `'/about.html'`, `'/blog/post.html'`). */
  initialPath?: string;
  /** Declared permissions from `permission.json` or operator sidecar. */
  declaredPermissions?: PermissionConfig;
  /** Currently granted capability list (updated dynamically when user clicks Allow on `PermissionBar`). */
  grantedCapabilities: readonly string[];
  /** Theme preference (`'light' | 'dark' | 'auto'`). */
  theme?: 'light' | 'dark' | 'auto';
  /** Whether guest storage persists to host `localStorage` (default `true`). */
  persistStorage?: boolean;
  /** Optional remote multi-user backend URL (replaces local in-browser backend worker). */
  backendUrl?: string;
  /** Shown while engine WASM & initial scripts boot. Can be a render function receiving live boot status. */
  loading?: React.ReactNode | ((status: ContainerBootStatus | null) => React.ReactNode);
  /** Rendered if container startup fails fatally. */
  error?: (err: Error) => React.ReactNode;
  /** Fired on each startup stage with message/percent/detail. */
  onStatus?: (status: ContainerBootStatus) => void;
  /** Fired once container initial scripts & `DOMContentLoaded` complete. */
  onReady?: () => void;
  /** Fired when guest updates `document.title` or navigates to a page with a `<title>`. */
  onTitleChange?: (title: string) => void;
  /** Fired when the container's virtual URL route changes (for syncing the host URL bar). */
  onRouteChange?: (urlPath: string, pushHistory: boolean) => void;
  /** Receives the live container handle when mounted and `null` on teardown. */
  onHandle?: (handle: SoftNContainerHandle | null) => void;
  /** Optional console listener. */
  onConsole?: (level: 'log' | 'info' | 'warn' | 'error', text: string) => void;
  /**
   * Whether the app is on screen (default `true`). A host that keeps several apps open and shows
   * one passes `false` for the others: such an app is asked for no frames and its timers wait
   * until it is shown again, as a hidden SoftN app's loops do.
   */
  active?: boolean;
}

/**
 * Shared React host wrapper that lazily imports `@softn/container` and mounts
 * a Worker-isolated SoftN v2 Web App Container inside a closed ShadowRoot.
 */
export function WebContainerView({
  source,
  runtimeUrl,
  appId,
  storagePrefix,
  initialPage,
  initialPath,
  declaredPermissions,
  grantedCapabilities,
  theme = 'auto',
  persistStorage = true,
  backendUrl,
  loading,
  error: renderError,
  onStatus,
  onReady,
  onTitleChange,
  onRouteChange,
  onHandle,
  onConsole,
  active = true,
}: WebContainerViewProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<SoftNContainerHandle | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootStatus, setBootStatus] = useState<ContainerBootStatus | null>(null);
  const [fatalError, setFatalError] = useState<Error | null>(null);

  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onTitleRef = useRef(onTitleChange);
  onTitleRef.current = onTitleChange;
  const onRouteChangeRef = useRef(onRouteChange);
  onRouteChangeRef.current = onRouteChange;
  const onHandleRef = useRef(onHandle);
  onHandleRef.current = onHandle;
  const onConsoleRef = useRef(onConsole);
  onConsoleRef.current = onConsole;
  const initialPathRef = useRef(initialPath);
  if (!handleRef.current) initialPathRef.current = initialPath;
  const grantedRef = useRef(grantedCapabilities);
  grantedRef.current = grantedCapabilities;
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let cancelled = false;
    setBooting(true);
    setBootStatus({ phase: 'opening', message: 'Loading container runtime…', percent: 5 });
    setFatalError(null);

    void (async () => {
      try {
        const { mountSoftNContainer } = await import('@softn/container/mount');
        if (cancelled) return;
        const mounted = await mountSoftNContainer(el, {
          source,
          // The build's own folder and core's engine for the Python tiers (containerHost.ts).
          ...hostedContainerOptions(),
          ...(runtimeUrl ? { runtimeUrl } : {}),
          ...(initialPage ? { initialPage } : {}),
          ...(initialPathRef.current ? { initialPath: initialPathRef.current } : {}),
          appId,
          ...(storagePrefix ? { storagePrefix } : {}),
          ...(backendUrl ? { backendUrl } : {}),
          theme,
          persistStorage,
          // The host's own PermissionBar asks; the container never does. What the person has
          // already allowed is in place before the app's first script runs (a grant applied
          // after the mount came after the page's start-up `fetch`, which was refused).
          permissionMode: 'deny',
          initialGrantedCapabilities: grantedRef.current as Capability[],
          permissionsOverride: declaredPermissions as unknown as ContainerPermissions | undefined,
          onStatus: (status) => {
            if (cancelled) return;
            setBootStatus(status);
            onStatusRef.current?.(status);
          },
          // To the host's listener when it has one; otherwise to the browser's console, as an
          // app's own page would write there. With no listener the app's errors went nowhere:
          // a script that threw left a blank page and nothing to read.
          onConsole: (level, text) => {
            const listener = onConsoleRef.current;
            if (listener) listener(level, text);
            // eslint-disable-next-line no-console -- the app's own printing, at the level it printed at
            else console[level]('[SoftN app]', text);
          },
          onTitleChange: (title) => onTitleRef.current?.(title),
          onRouteChange: (urlPath, pushHistory) => onRouteChangeRef.current?.(urlPath, pushHistory),
          onError: (err) => {
            console.error('[SoftN Container]', err);
          },
        });
        if (cancelled) {
          mounted.dispose();
          return;
        }
        handleRef.current = mounted;
        onHandleRef.current?.(mounted);
        // Whatever changed while it started (the person pressed Allow during the boot).
        mounted.setGrantedCapabilities(grantedRef.current as Capability[]);
        mounted.setActive(activeRef.current);
        const normPage = initialPage ? initialPage.replace(/^\//, '') : '';
        const normCurrent = mounted.currentPath.replace(/^\//, '');
        if (initialPage && initialPage !== mounted.manifest.main && normCurrent !== normPage && !/\.html?$/i.test(initialPage)) {
          await mounted.navigate(initialPage).catch(() => undefined);
          if (cancelled) return;
        }
        setBooting(false);
        onReadyRef.current?.();
      } catch (err) {
        if (cancelled) return;
        const normalized = err instanceof Error ? err : new Error(String(err));
        setFatalError(normalized);
        setBooting(false);
      }
    })();

    return () => {
      cancelled = true;
      onHandleRef.current?.(null);
      handleRef.current?.dispose();
      handleRef.current = null;
    };
  }, [source, runtimeUrl, appId, storagePrefix, backendUrl, theme, persistStorage, declaredPermissions, initialPage]);

  // Dynamically upgrade/revoke capabilities in-place when user clicks Allow on host PermissionBar
  useEffect(() => {
    handleRef.current?.setGrantedCapabilities(grantedCapabilities as Capability[]);
  }, [grantedCapabilities]);

  // Shown or not: an app behind another tab runs nothing until it is in front again.
  useEffect(() => {
    handleRef.current?.setActive(active);
  }, [active]);

  if (fatalError && renderError) {
    return <>{renderError(fatalError)}</>;
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', flex: '1 1 auto', minHeight: 0 }}>
      <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
      {booting && loading && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 2 }}>
          {typeof loading === 'function' ? loading(bootStatus) : loading}
        </div>
      )}
    </div>
  );
}
