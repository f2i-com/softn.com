import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerAllBuiltins } from '@softn/components';
import App from './App';

// Register all SoftN built-in components
registerAllBuiltins();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
