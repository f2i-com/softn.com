import React from 'react';
import ReactDOM from 'react-dom/client';

// The same look as softn.com, the runtime and Builder: one set of tokens, the
// same faces and the same product bar, from one package — self-hosted, because
// an app that installs and runs offline should not need a font CDN to render
// its own chrome.
import '@softn/brand/fonts';
import '@softn/brand/tokens.css';
import '@softn/brand/bar.css';
import './styles/studio.css';
import './styles/editor.css';
import './styles/ai-setup.css';

import App from './App';
import { AppBoundary } from './components/common/AppBoundary';
import { PWAPrompt } from './components/common/PWAPrompt';
import { awaitZippWasmSource } from '@softn/core';
import { hostedEngineSource, isHostedEditor } from '@softn/editor-shared/hostedEditor';
import zippSource from '../../../packages/@softn/core/wasm-zipp/SOURCE.json';

// In FormLogic the engine comes from the page that opened Studio, which has
// downloaded and checked it already: one file for the whole site, and the
// Studio FormLogic installs carries no copy of its own.
if (isHostedEditor()) awaitZippWasmSource(hostedEngineSource(zippSource));

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppBoundary>
      <App />
      <PWAPrompt />
    </AppBoundary>
  </React.StrictMode>,
);
