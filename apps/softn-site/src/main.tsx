import React from 'react';
import ReactDOM from 'react-dom/client';

// Self-hosted rather than pulled from a font CDN: this is the front door of an
// offline-first runtime, and it should not need a third party to render.
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';

import './styles.css';
import App from './App';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
