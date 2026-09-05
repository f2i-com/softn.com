import React from 'react';
import ReactDOM from 'react-dom/client';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { registerAllBuiltins } from '@softn/components';
// The same look as softn.com, the runtime and Studio: one set of tokens, the
// same faces and the same product bar, from one package — bundled, so the
// builder still looks like itself offline. It is installable, and a PWA that
// falls back to Segoe UI is a different product on every machine.
import '@softn/brand/fonts';
import '@softn/brand/tokens.css';
import '@softn/brand/bar.css';
import App from './App';

// Register all SoftN components
registerAllBuiltins();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DndProvider backend={HTML5Backend}>
      <App />
    </DndProvider>
  </React.StrictMode>
);
