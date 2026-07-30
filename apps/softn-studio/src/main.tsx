import React from 'react';
import ReactDOM from 'react-dom/client';

// The same pairing softn.com uses, self-hosted for the same reason: an app that
// installs and runs offline should not need a font CDN to render its own chrome.
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';

import App from './App';
import { PWAPrompt } from './components/common/PWAPrompt';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <PWAPrompt />
  </React.StrictMode>,
);
