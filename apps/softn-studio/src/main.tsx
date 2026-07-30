import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { PWAPrompt } from './components/common/PWAPrompt';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <PWAPrompt />
  </React.StrictMode>,
);
