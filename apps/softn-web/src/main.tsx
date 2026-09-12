import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerRuntimeComponents } from '@softn/components/lazy';
// The runtime's chrome wears the same look as the site, Studio and Builder:
// one set of tokens, the same faces and the same product bar. The apps it
// runs are unaffected — they bring their own themes.
import '@softn/brand/fonts';
import '@softn/brand/tokens.css';
import '@softn/brand/bar.css';
import App from './App';
import { FieldnotesPreview } from './components/FieldnotesPreview';

// The minimal set now, every other built-in by loader: a document that never
// names Scene3D never fetches Three.js, and one that names it on its first
// screen has it fetched while the VM starts. The same call as softn-single,
// so the two hosts load the same names the same way (docs/COMPONENT_LOADING.md).
registerRuntimeComponents();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).get('preview') === 'fieldnotes' ? <FieldnotesPreview /> : <App />}
  </React.StrictMode>
);
