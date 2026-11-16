import React, { useEffect, useRef } from 'react';
import type { Capability } from '@softn/bundle-format/capabilities';
import { mountSoftNContainer, type ContainerPermissions, type SoftNContainerHandle } from '@softn/container';
import type { PermissionConfig } from '@softn/core';

export interface ContainerPreviewRuntimeProps {
  projectId: string;
  files: Record<string, string | Uint8Array>;
  themeMode: 'light' | 'dark' | 'system';
  declaredPermissions: PermissionConfig | null;
  grantedCapabilities: string[];
  onError?: (error: Error) => void;
}

export function ContainerPreviewRuntime({
  projectId,
  files,
  themeMode,
  declaredPermissions,
  grantedCapabilities,
  onError,
}: ContainerPreviewRuntimeProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<SoftNContainerHandle | null>(null);
  const grantedRef = useRef(grantedCapabilities);
  grantedRef.current = grantedCapabilities;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const filesKey = JSON.stringify(
    Object.keys(files)
      .sort()
      .map((k) => {
        const v = files[k];
        return [k, typeof v === 'string' ? v : `b:${v.byteLength}`];
      })
  );

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let cancelled = false;

    const base = import.meta.env.BASE_URL || '/';
    const runtimeUrl = `${base.endsWith('/') ? base : `${base}/`}assets/container-runtime/`;

    mountSoftNContainer(el, {
      source: files,
      appId: `builder-preview-${projectId}`,
      runtimeUrl,
      theme: themeMode === 'dark' || themeMode === 'light' ? themeMode : 'auto',
      persistStorage: false,
      permissionMode: 'deny',
      permissionsOverride: (declaredPermissions ?? undefined) as unknown as ContainerPermissions | undefined,
      onError: (err: Error) => {
        if (!cancelled) onErrorRef.current?.(err);
      },
    })
      .then((handle) => {
        if (cancelled) {
          handle.dispose();
          return;
        }
        handleRef.current = handle;
        if (grantedRef.current.length > 0) {
          handle.setGrantedCapabilities(grantedRef.current as Capability[]);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          onErrorRef.current?.(err instanceof Error ? err : new Error(String(err)));
        }
      });

    return () => {
      cancelled = true;
      handleRef.current?.dispose();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, filesKey, themeMode]);

  useEffect(() => {
    handleRef.current?.setGrantedCapabilities(grantedCapabilities as Capability[]);
  }, [grantedCapabilities]);

  return (
    <div
      ref={hostRef}
      data-container-preview="true"
      style={{ width: '100%', height: '100%', minHeight: 320, position: 'relative', overflow: 'auto' }}
    />
  );
}
