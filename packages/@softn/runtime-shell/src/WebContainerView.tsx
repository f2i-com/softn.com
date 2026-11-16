import React, { useEffect, useRef, useState } from 'react';
import type { Capability } from '@softn/bundle-format/capabilities';
import type { PermissionConfig } from '@softn/core';
import type { ContainerPermissions, SoftNContainerHandle } from '@softn/container';

export interface WebContainerViewProps {
  /** Raw `.softn`/`.zip` archive bytes or unpacked VFS map. */
  source: Uint8Array | Record<string, string | Uint8Array>;
  /** Base URL for `@softn/container`'s runtime assets (`assets/container-runtime/`). */
  runtimeUrl?: string;
  /** Content-addressed identity for isolated container storage. */
  appId: string;
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

function defaultRuntimeUrl(): string {
  const metaEnv = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
  const base = metaEnv?.BASE_URL ?? './';
  return `${base.replace(/\/?$/, '/')}assets/container-runtime/`;
}

/**
 * Shared React host wrapper that lazily imports `@softn/container` and mounts
 * a Worker-isolated SoftN v2 Web App Container inside a closed ShadowRoot.
 */
export function WebContainerView({
  source,
  runtimeUrl,
  appId,
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
          runtimeUrl: runtimeUrl ?? defaultRuntimeUrl(),
          appId,
          theme,
          persistStorage,
          // Host's own PermissionBar owns UI; start withheld and apply `grantedCapabilities` immediately
          permissionMode: 'deny',
          permissionsOverride: declaredPermissions as unknown as ContainerPermissions | undefined,
          onConsole: (level, text) => onConsoleRef.current?.(level, text),
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
        if (grantedRef.current.length > 0) {
          mounted.setGrantedCapabilities(grantedRef.current as Capability[]);
        }
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
  }, [source, runtimeUrl, appId, theme, persistStorage, declaredPermissions, initialPage]);

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
