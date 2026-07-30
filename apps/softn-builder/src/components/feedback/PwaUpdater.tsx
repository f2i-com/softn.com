/// <reference types="vite-plugin-pwa/react" />

/**
 * PwaUpdater - Registers the service worker and surfaces its update prompt
 */

import { useEffect, useRef } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useNotificationStore } from '../../stores/notificationStore';

export function PwaUpdater() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  const prompted = useRef(false);

  useEffect(() => {
    // The hook hands back a fresh updateServiceWorker on some renders, so
    // without this guard the effect would stack up duplicate toasts.
    if (!needRefresh || prompted.current) return;
    prompted.current = true;

    useNotificationStore.getState().addNotification({
      type: 'info',
      message: 'Update ready',
      // Reloading throws away whatever is on the canvas, so the prompt waits
      // for the user instead of expiring on its own.
      duration: 0,
      action: {
        label: 'Reload',
        onClick: () => void updateServiceWorker(true),
      },
    });
  }, [needRefresh, updateServiceWorker]);

  return null;
}
