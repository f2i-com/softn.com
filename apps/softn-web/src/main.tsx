import React from 'react';
import ReactDOM from 'react-dom/client';
import { cacheUncontrolledZippEngine } from '@softn/core/web-host';
// The runtime's chrome wears the same look as the site, Studio and Builder:
// one set of tokens, the same faces and the same product bar. The apps it
// runs are unaffected — they bring their own themes.
import '@softn/brand/fonts';
import '@softn/brand/tokens.css';
import '@softn/brand/bar.css';
import App from './App';

if (import.meta.env.PROD) cacheUncontrolledZippEngine('softn-full-engine');

const LazyFieldnotesPreview = React.lazy(() =>
  import('./components/FieldnotesPreview').then((m) => ({ default: m.FieldnotesPreview }))
);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).get('preview') === 'fieldnotes' ? (
      <React.Suspense fallback={null}>
        <LazyFieldnotesPreview />
      </React.Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>
);
