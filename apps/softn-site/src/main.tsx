import React from 'react';
import ReactDOM from 'react-dom/client';

// The look is shared with the runtime, Studio and Builder: the faces, the
// tokens and the product bar all come from one package, imported here ahead
// of the site's own styles so those can build on them.
import '@softn/brand/fonts';
import '@softn/brand/tokens.css';
import '@softn/brand/bar.css';

import './styles.css';
import App from './App';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

// Capture SSR route marker before React replaces `#root`'s children during initial mount.
const ssrKind = root.querySelector('[data-softn-ssr]')?.getAttribute('data-softn-ssr');
if (ssrKind) {
  document.documentElement.dataset.softnSsr = ssrKind;
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
