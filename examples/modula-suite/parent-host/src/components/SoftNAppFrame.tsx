import React, { useEffect, useRef, useState } from 'react';
import {
  mountSoftNContainer,
  type ContainerBootStatus,
  type SoftNContainerHandle,
} from '@softn/container';

export interface SoftNAppFrameProps {
  appId: string;
  source: string | Uint8Array;
  active: boolean;
  backendUrl?: string;
  runtimeUrl?: string;
  onHandleReady?: (appId: string, handle: SoftNContainerHandle | null) => void;
}

export const SoftNAppFrame: React.FC<SoftNAppFrameProps> = ({
  appId,
  source,
  active,
  backendUrl,
  runtimeUrl = '/runtime/',
  onHandleReady,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<SoftNContainerHandle | null>(null);
  const [status, setStatus] = useState<ContainerBootStatus>({
    phase: 'opening',
    message: 'Opening SoftN container...',
    percent: 10,
  });
  const [ready, setReady] = useState(false);
  const [mountError, setMountError] = useState<string | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    let cancelled = false;
    setReady(false);
    setMountError(null);
    setStatus({ phase: 'opening', message: 'Booting isolated ZIPP WASM workers...', percent: 12 });

    void mountSoftNContainer(el, {
      source,
      appId,
      runtimeUrl,
      backendUrl,
      theme: 'light',
      permissionMode: 'deny',
      onStatus: (next) => {
        if (!cancelled) setStatus(next);
      },
      onReady: () => {
        if (!cancelled) setReady(true);
      },
      onError: (err) => {
        if (!cancelled) setMountError(err.message || String(err));
      },
    })
      .then((mounted) => {
        if (cancelled) {
          mounted.dispose();
          return;
        }
        handleRef.current = mounted;
        mounted.setActive(active);
        setReady(true);
        onHandleReady?.(appId, mounted);
      })
      .catch((err) => {
        if (!cancelled) {
          setMountError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      cancelled = true;
      onHandleReady?.(appId, null);
      handleRef.current?.dispose();
      handleRef.current = null;
    };
    // Intentionally remount only when appId, source, or backendUrl changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, source, backendUrl, runtimeUrl]);

  useEffect(() => {
    handleRef.current?.setActive(active);
  }, [active]);

  return (
    <div
      className="container-viewport-wrap"
      style={{ display: active ? 'flex' : 'none' }}
      data-modula-app-id={appId}
    >
      {!ready && !mountError && (
        <div className="boot-overlay">
          <div className="boot-card">
            <div className="boot-spinner" />
            <div className="boot-title">{status.message}</div>
            <div className="boot-meta">
              {backendUrl
                ? `Connecting to Standalone PHP backend (${backendUrl})`
                : 'Starting React (ZIPP Lite WASM) + PHP 8 (ZIPP PHP WASM) + XDB SQLite'}
            </div>
            <div className="boot-bar">
              <div className="boot-bar-fill" style={{ width: `${Math.max(15, status.percent ?? 35)}%` }} />
            </div>
          </div>
        </div>
      )}

      {mountError && (
        <div className="boot-overlay">
          <div className="boot-card boot-error">
            <div className="boot-title">Container failed to start</div>
            <div className="boot-meta">{mountError}</div>
          </div>
        </div>
      )}

      <div ref={hostRef} className="container-mount-target" />
    </div>
  );
};
