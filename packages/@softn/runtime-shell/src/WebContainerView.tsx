import React, { useEffect, useRef, useState } from 'react';
import type { Capability } from '@softn/bundle-format/capabilities';
import type { PermissionConfig } from '@softn/core';
import type { ContainerPermissions, SoftNContainerHandle } from '@softn/container';
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
  /** Declared permissions from `permission.json` or operator sidecar. */
  declaredPermissions?: PermissionConfig;
  /** Currently granted capability list (updated dynamically when user clicks Allow on `PermissionBar`). */
  grantedCapabilities: readonly string[];
  /** Theme preference (`'light' | 'dark' | 'auto'`). */
  theme?: 'light' | 'dark' | 'auto';
  /** Whether guest storage persists to host `localStorage` (default `true`). */
  persistStorage?: boolean;
  /** Shown while engine WASM & initial scripts boot. */
  loading?: React.ReactNode;
  /** Rendered if container startup fails fatally. */
  error?: (err: Error) => React.ReactNode;
  /** Fired once container initial scripts & `DOMContentLoaded` complete. */
  onReady?: () => void;
  /** Fired when guest updates `document.title`. */
  onTitleChange?: (title: string) => void;
  /** Optional console listener. */
  onConsole?: (level: 'log' | 'info' | 'warn' | 'error', text: string) => void;
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
  declaredPermissions,
  grantedCapabilities,
  theme = 'auto',
  persistStorage = true,
  loading,
  error: renderError,
  onReady,
  onTitleChange,
  onConsole,
}: WebContainerViewProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<SoftNContainerHandle | null>(null);
  const [booting, setBooting] = useState(true);
  const [fatalError, setFatalError] = useState<Error | null>(null);

  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onTitleRef = useRef(onTitleChange);
  onTitleRef.current = onTitleChange;
  const onConsoleRef = useRef(onConsole);
  onConsoleRef.current = onConsole;
  const grantedRef = useRef(grantedCapabilities);
  grantedRef.current = grantedCapabilities;

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let cancelled = false;
    setBooting(true);
    setFatalError(null);

    void (async () => {
      try {
        const { mountSoftNContainer } = await import('@softn/container');
        if (cancelled) return;
        const mounted = await mountSoftNContainer(el, {
          source,
          // The build's own folder and core's engine for the Python tiers (containerHost.ts).
          ...hostedContainerOptions(),
          ...(runtimeUrl ? { runtimeUrl } : {}),
          appId,
          ...(storagePrefix ? { storagePrefix } : {}),
          theme,
          persistStorage,
          // The host's own PermissionBar asks; the container never does. What the person has
          // already allowed is in place before the app's first script runs (a grant applied
          // after the mount came after the page's start-up `fetch`, which was refused).
          permissionMode: 'deny',
          initialGrantedCapabilities: grantedRef.current as Capability[],
          permissionsOverride: declaredPermissions as unknown as ContainerPermissions | undefined,
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
          onError: (err) => {
            console.error('[SoftN Container]', err);
          },
        });
        if (cancelled) {
          mounted.dispose();
          return;
        }
        handleRef.current = mounted;
        // Whatever changed while it started (the person pressed Allow during the boot).
        mounted.setGrantedCapabilities(grantedRef.current as Capability[]);
        if (initialPage && initialPage !== mounted.manifest.main) {
          await mounted.navigate(initialPage).catch(() => undefined);
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
      handleRef.current?.dispose();
      handleRef.current = null;
    };
  }, [source, runtimeUrl, appId, storagePrefix, theme, persistStorage, declaredPermissions, initialPage]);

  // Dynamically upgrade/revoke capabilities in-place when user clicks Allow on host PermissionBar
  useEffect(() => {
    handleRef.current?.setGrantedCapabilities(grantedCapabilities as Capability[]);
  }, [grantedCapabilities]);

  if (fatalError && renderError) {
    return <>{renderError(fatalError)}</>;
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', flex: '1 1 auto', minHeight: 0 }}>
      <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
      {booting && loading && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 2 }}>
          {loading}
        </div>
      )}
    </div>
  );
}
