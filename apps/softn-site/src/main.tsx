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

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
