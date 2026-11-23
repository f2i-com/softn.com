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
    percent: 12,
  });
  const [ready, setReady] = useState(false);
  const [mountError, setMountError] = useState<string | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    let cancelled = false;
    setReady(false);
    setMountError(null);
    setStatus({ phase: 'opening', message: 'Booting React + PHP 8 ZIPP WASM workers...', percent: 15 });

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
    // Remount only when container source, appId, or backend execution mode changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, source, backendUrl, runtimeUrl]);

  useEffect(() => {
    handleRef.current?.setActive(active);
  }, [active]);

  return (
    <div
      className="container-stage"
      style={{ display: active ? 'flex' : 'none' }}
      data-opal-app-id={appId}
    >
      {!ready && !mountError && (
        <div className="boot-overlay">
          <div className="boot-card">
            <div className="boot-spinner" />
            <div className="boot-title">{status.message}</div>
            <div className="boot-meta">
              {backendUrl
                ? `Connecting to Standalone PHP 8 host (${backendUrl})`
                : 'Starting React (ZIPP JS Lite WASM) · PHP 8 (ZIPP PHP WASM) · XDB SQLite 3'}
            </div>
            <div className="boot-bar">
              <div className="boot-bar-fill" style={{ width: `${Math.max(18, status.percent ?? 40)}%` }} />
            </div>
          </div>
        </div>
      )}

      {mountError && (
        <div className="boot-overlay">
          <div className="boot-card boot-error">
            <div className="boot-title">SoftN Container Failed to Boot</div>
            <div className="boot-meta">{mountError}</div>
          </div>
        </div>
      )}

      <div ref={hostRef} className="container-mount-target" />
    </div>
  );
};
