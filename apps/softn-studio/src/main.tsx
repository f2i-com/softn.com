import React from 'react';
import ReactDOM from 'react-dom/client';

// The same look as softn.com, the runtime and Builder: one set of tokens, the
// same faces and the same product bar, from one package — self-hosted, because
// an app that installs and runs offline should not need a font CDN to render
// its own chrome.
import '@softn/brand/fonts';
import '@softn/brand/tokens.css';
import '@softn/brand/bar.css';

import App from './App';
import { PWAPrompt } from './components/common/PWAPrompt';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <PWAPrompt />
  </React.StrictMode>,
);
