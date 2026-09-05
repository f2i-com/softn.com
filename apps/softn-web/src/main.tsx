import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerAllBuiltins } from '@softn/components';
// The runtime's chrome wears the same look as the site, Studio and Builder:
// one set of tokens, the same faces and the same product bar. The apps it
// runs are unaffected — they bring their own themes.
import '@softn/brand/fonts';
import '@softn/brand/tokens.css';
import '@softn/brand/bar.css';
import App from './App';

// Register all SoftN built-in components
registerAllBuiltins();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
