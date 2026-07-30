import React, { useCallback, useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

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

export const PWAPrompt: React.FC = () => {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);

  // The hook's own `needRefresh` never fires under registerType 'autoUpdate' —
  // that mode reloads on activation instead of asking — so the waiting worker
  // is tracked off the registration directly.
  useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      const track = (worker: ServiceWorker | null) => {
        // A worker that reaches `installed` with nothing controlling the page
        // is the very first install, not an update worth interrupting for.
        if (worker && worker.state === 'installed' && navigator.serviceWorker.controller) {
          setWaiting(worker);
        }
      };
      const watch = (worker: ServiceWorker | null) => {
        if (!worker) return;
        track(worker);
        worker.addEventListener('statechange', () => track(worker));
      };
      track(registration.waiting);
      // A worker can already be installing by the time this runs — that is the
      // normal case in a second tab, where another tab's registration fired
      // `updatefound` for it before this one attached the listener below. It
      // will never fire that event again, so without picking it up here the tab
      // stays on the old build until it is closed.
      watch(registration.installing);
      registration.addEventListener('updatefound', () => watch(registration.installing));
    },
  });

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
    if (!waiting) return;
    // The generated worker only calls skipWaiting() when asked, and it takes
    // over this page once it activates, so the controller swap is the cue that
    // the new build is live and the reload will land on it.
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
    waiting.postMessage({ type: 'SKIP_WAITING' });
    setWaiting(null);
  }, [waiting]);

  const handleInstall = useCallback(async () => {
    if (!installEvent) return;
    // A prompt can only be shown once, so the button goes away either way.
    setInstallEvent(null);
    await installEvent.prompt();
    await installEvent.userChoice;
  }, [installEvent]);

  if (!waiting && !installEvent) return null;

  return (
    <div style={styles.dock}>
      {waiting && (
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

// This renders outside the App subtree that applies the studio tokens, so it
// depends on App mirroring them onto the document element to follow the theme.
// The fallbacks are the dark palette, which is what shows in the moment before
// that effect runs and if the mirroring is ever removed.
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
    background: 'var(--studio-panel, rgba(15,23,42,0.82))',
    border: '1px solid var(--studio-border, rgba(148,163,184,0.14))',
    boxShadow: 'var(--studio-shadow, 0 18px 40px rgba(2,6,23,0.24))',
    backdropFilter: 'blur(8px)',
    fontSize: 12,
    color: 'var(--studio-text, #f8fafc)',
  },
  label: {
    whiteSpace: 'nowrap',
  },
  action: {
    padding: '4px 12px',
    borderRadius: 999,
    border: '1px solid var(--studio-accent, #38bdf8)',
    background: 'transparent',
    color: 'var(--studio-accent, #38bdf8)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  installButton: {
    padding: '8px 16px',
    color: 'var(--studio-accent, #38bdf8)',
    fontWeight: 600,
    cursor: 'pointer',
  },
};
