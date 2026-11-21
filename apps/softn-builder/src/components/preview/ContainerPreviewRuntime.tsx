import React, { useEffect, useRef, useState } from 'react';
import type { Capability } from '@softn/bundle-format/capabilities';
import {
  mountSoftNContainer,
  type ContainerBootStatus,
  type ContainerPermissions,
  type SoftNContainerHandle,
} from '@softn/container';
import type { PermissionConfig } from '@softn/core';
import { hostedContainerOptions } from '@softn/runtime-shell/containerHost';
import { webPreviewEntries } from '@softn/editor-shared/prepareWebSource';

// Which bytes a file's are, by the array that holds them: an image replaced by another of
// the same size is another array. (Keyed by its length alone, the preview kept the old one.)
const binaryIds = new WeakMap<Uint8Array, number>();
let nextBinaryId = 1;
function binaryId(bytes: Uint8Array): number {
  let id = binaryIds.get(bytes);
  if (id === undefined) {
    id = nextBinaryId++;
    binaryIds.set(bytes, id);
  }
  return id;
}

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
  const [bootStatus, setBootStatus] = useState<ContainerBootStatus | null>(null);
  const grantedRef = useRef(grantedCapabilities);
  grantedRef.current = grantedCapabilities;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const filesKey = JSON.stringify(
    Object.keys(files)
      .sort()
      .map((k) => {
        const v = files[k];
        return [k, typeof v === 'string' ? v : `b:${binaryId(v)}`];
      })
  );

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let cancelled = false;
    setBootStatus({ phase: 'opening', message: 'Starting container preview…', percent: 10 });

    void (async () => {
      const source = await webPreviewEntries(files);
      if (cancelled) return;
      const handle = await mountSoftNContainer(el, {
        source,
        appId: `builder-preview-${projectId}`,
        // The build's own folder and core's engine for the Python tiers.
        ...hostedContainerOptions(),
        theme: themeMode === 'dark' || themeMode === 'light' ? themeMode : 'auto',
        persistStorage: false,
        // The Builder asks; what was allowed in this preview is in place before the app's
        // first script runs.
        permissionMode: 'deny',
        initialGrantedCapabilities: grantedRef.current as Capability[],
        permissionsOverride: (declaredPermissions ?? undefined) as unknown as ContainerPermissions | undefined,
        onStatus: (status) => {
          if (!cancelled) setBootStatus(status);
        },
        onError: (err: Error) => {
          if (!cancelled) onErrorRef.current?.(err);
        },
      });
      if (cancelled) {
        handle.dispose();
        return;
      }
      handleRef.current = handle;
      handle.setGrantedCapabilities(grantedRef.current as Capability[]);
      setBootStatus(null);
    })()
      .catch((err: unknown) => {
        if (!cancelled) {
          setBootStatus(null);
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
    <div style={{ width: '100%', height: '100%', minHeight: 320, position: 'relative' }}>
      <div
        ref={hostRef}
        data-container-preview="true"
        style={{ width: '100%', height: '100%', minHeight: 320, position: 'relative', overflow: 'auto' }}
      />
      {bootStatus && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            background: 'var(--bl-bg, rgba(15, 23, 42, 0.88))',
            color: 'var(--paper, #f8fafc)',
            fontSize: 13,
            pointerEvents: 'none',
            zIndex: 2,
          }}
        >
          <strong>{bootStatus.message}</strong>
          {bootStatus.detail && <span style={{ opacity: 0.72, fontSize: 12 }}>{bootStatus.detail}</span>}
        </div>
      )}
    </div>
  );
}
