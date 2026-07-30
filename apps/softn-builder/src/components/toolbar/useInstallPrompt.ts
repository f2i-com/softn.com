/**
 * useInstallPrompt - Keeps the browser's deferred PWA install prompt available
 */

import { useCallback, useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isInstalled(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS never fires beforeinstallprompt and reports an installed app here.
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function useInstallPrompt() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (isInstalled()) return;

    const handleBeforeInstallPrompt = (event: Event) => {
      // Chrome drops its own install banner over the toolbar unless the event
      // is cancelled; holding on to it lets the Install button drive instead.
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
    };
    const handleInstalled = () => setInstallEvent(null);

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleInstalled);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!installEvent) return;
    await installEvent.prompt();
    await installEvent.userChoice;
    // Each event can only be prompted once; the browser sends another one if
    // the user declines and later becomes eligible again.
    setInstallEvent(null);
  }, [installEvent]);

  return { canInstall: installEvent !== null, promptInstall };
}
