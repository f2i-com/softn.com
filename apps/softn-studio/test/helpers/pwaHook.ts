/**
 * The service worker's registration hook, as the tests see it. The app
 * imports it from `virtual:softn-pwa/react`, which the build's plugin
 * provides (scripts/build/pwa.mjs); vitest.config.ts points that name here.
 * A test says what the worker has to report before it draws PWAPrompt.
 */
import { useState } from 'react';

export const pwaTest = { offlineReady: false, needRefresh: false };

export function useRegisterSW(): {
  needRefresh: [boolean, (value: boolean) => void];
  offlineReady: [boolean, (value: boolean) => void];
  updateServiceWorker: (reload?: boolean) => Promise<void>;
} {
  const needRefresh = useState(pwaTest.needRefresh);
  const offlineReady = useState(pwaTest.offlineReady);
  return { needRefresh, offlineReady, updateServiceWorker: async () => {} };
}
