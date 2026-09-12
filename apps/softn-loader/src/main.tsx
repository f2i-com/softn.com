import React from 'react';
import ReactDOM from 'react-dom/client';
// Bundled, not fetched: this is a desktop app that has to look right with the
// network off, and these are the faces the landing page and Studio already use.
import '@softn/brand/fonts';
import '@softn/brand/tokens.css';
import '@softn/brand/bar.css';
import { apply, readChoice, resolve } from '@softn/brand';
import App from './App';

apply(resolve(readChoice()));

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
