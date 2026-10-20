import React, { useCallback, useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:softn-pwa/react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** How long the "ready offline" line stays before it goes by itself; a failure stays until dismissed. */
const READY_NOTICE_MS = 12_000;

/**
 * The service worker's three things to say: a new build is waiting (Reload
 * takes it), Studio is installed for offline use, and installing it for
 * offline use failed.
 *
 * The registration hook (scripts/build/pwa.mjs) watches the waiting and the
 * installing worker itself — the one already installing when this tab
 * registers, as well as one that arrives later — and answers `needRefresh`
 * for a worker installed while a page is controlled (an update) and
 * `offlineReady` for one installed while none is (the first install). The
 * worker waits for SKIP_WAITING (registerType 'prompt'), so an update never
 * reloads the canvas out from under a design in progress.
 */
export const PWAPrompt: React.FC = () => {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  /** Why Studio could not be installed for offline use, until dismissed. */
  const [offlineFailure, setOfflineFailure] = useState<string | null>(null);

  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      // The first install, followed to its end. A worker thrown away before it was installed
      // did not finish keeping Studio's files (one did not download, or storage refused it),
      // and the hook says nothing of that. An update that fails leaves the installed build
      // working offline, so only a first install is followed.
      const followed = new WeakSet<ServiceWorker>();
      const followFirstInstall = (worker: ServiceWorker | null) => {
        if (!worker || followed.has(worker) || navigator.serviceWorker.controller) return;
        followed.add(worker);
        let installed = worker.state !== 'installing' && worker.state !== 'parsed';
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed') installed = true;
          else if (worker.state === 'redundant' && !installed) {
            setOfflineFailure('one of its files could not be downloaded or stored');
          }
        });
      };
      followFirstInstall(registration.installing);
      registration.addEventListener('updatefound', () => followFirstInstall(registration.installing));
    },
    onRegisterError(error) {
      setOfflineFailure(error instanceof Error && error.message ? error.message : 'the browser refused its service worker');
    },
  });

  // Said once, and then out of the way.
  useEffect(() => {
    if (!offlineReady) return;
    const timer = window.setTimeout(() => setOfflineReady(false), READY_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [offlineReady, setOfflineReady]);

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      // Chrome shows its own mini-infobar unless the event is cancelled, and
      // the event object is the only handle on the prompt, so it is kept.
      event.preventDefault();
      if (!isStandalone()) setInstallEvent(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setInstallEvent(null);
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const handleReload = useCallback(() => {
    // The worker only calls skipWaiting() when asked, and it takes over this
    // page once it activates; the hook reloads on that controller swap, which
    // is the cue that the new build is live and the reload will land on it.
    setNeedRefresh(false);
    void updateServiceWorker(true);
  }, [setNeedRefresh, updateServiceWorker]);

  const handleInstall = useCallback(async () => {
    if (!installEvent) return;
    // A prompt can only be shown once, so the button goes away either way.
    setInstallEvent(null);
    await installEvent.prompt();
    await installEvent.userChoice;
  }, [installEvent]);

  const notice = offlineFailure
    ? { text: `Studio could not be installed for offline use: ${offlineFailure.replace(/[.\s]+$/, '')}. It still works while you are online; reload to try again.`, dismiss: () => setOfflineFailure(null) }
    : offlineReady
      ? { text: 'Studio is ready to work offline.', dismiss: () => setOfflineReady(false) }
      : null;

  return (
    <div style={styles.dock}>
      {/* Always in the page, so a screen reader hears what is put in it. */}
      <div role="status" aria-live="polite">
        {notice && (
          <div style={{ ...styles.card, ...styles.notice }}>
            <span>{notice.text}</span>
            <button type="button" onClick={notice.dismiss} style={styles.dismiss} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
      </div>
      {needRefresh && (
        <div style={styles.card}>
          <span style={styles.label}>Update ready</span>
          <button onClick={handleReload} style={styles.action}>Reload</button>
        </div>
      )}
      {installEvent && (
        <button onClick={handleInstall} style={{ ...styles.card, ...styles.installButton }}>
          Install
        </button>
      )}
    </div>
  );
};

// This is mounted beside App, not inside it (main.tsx). The --studio-* tokens it
// reads are defined on :root by styles/studio.css, so it follows the theme switch
// like the rest of Studio. Literal fallbacks used to be inlined here, a second copy
// of the palette that went stale (they still held the old sky-blue accent after
// Studio moved to coral); no colour is spelled out here now.
const styles: Record<string, React.CSSProperties> = {
  dock: {
    position: 'fixed',
    right: 16,
    bottom: 48,
    zIndex: 1000,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 8,
  },
  card: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 10px 8px 14px',
    borderRadius: 999,
    background: 'var(--studio-panel)',
    border: '1px solid var(--studio-border)',
    boxShadow: 'var(--studio-shadow)',
    backdropFilter: 'blur(8px)',
    fontSize: 12,
    color: 'var(--studio-text)',
  },
  label: {
    fontFamily: 'var(--studio-mono)',
    whiteSpace: 'nowrap',
  },
  action: {
    padding: '4px 12px',
    borderRadius: 999,
    border: '1px solid var(--studio-accent)',
    background: 'transparent',
    color: 'var(--studio-accent)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  installButton: {
    padding: '8px 16px',
    color: 'var(--studio-accent)',
    fontWeight: 600,
    cursor: 'pointer',
  },
  notice: {
    borderRadius: 12,
    maxWidth: 'min(420px, calc(100vw - 32px))',
    lineHeight: 1.4,
  },
  dismiss: {
    flexShrink: 0,
    width: 24,
    height: 24,
    borderRadius: 6,
    border: '1px solid var(--studio-border)',
    background: 'transparent',
    color: 'var(--studio-text)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    lineHeight: 1,
  },
};
