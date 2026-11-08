import React from 'react';
import ReactDOM from 'react-dom/client';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { registerRuntimeComponents } from '@softn/components/lazy';
// The same look as softn.com, the runtime and Studio: one set of tokens, the
// same faces and the same product bar, from one package — bundled, so the
// builder still looks like itself offline. It is installable, and a PWA that
// falls back to Segoe UI is a different product on every machine.
import '@softn/brand/fonts';
import '@softn/brand/tokens.css';
import '@softn/brand/bar.css';
// Builder's own chrome on those tokens: focus, form controls, shared controls.
import './styles/builder.css';
import App from './App';
import { AppBoundary } from './components/AppBoundary';
import { awaitZippGlue, awaitZippWasmSource, configureZippTorchSource } from '@softn/core';
import { hostedEngineSource, hostedGlueSource, isHostedEditor } from '@softn/editor-shared/hostedEditor';
import zippSource from '../../../packages/@softn/core/wasm-zipp/SOURCE.json';

// In FormLogic the engine comes from the page that opened the Builder, which
// has downloaded and checked it already: one file for the whole site, and the
// Builder FormLogic installs carries no copy of its own. With it, the glue of
// the site's own ZIPP where FormLogic serves one, so the Builder runs the ZIPP
// the site has, which may be newer than the one it was built with.
if (isHostedEditor()) {
  awaitZippWasmSource(hostedEngineSource(zippSource));
  // The site's torch package with its glue: the one built for its engine.
  awaitZippGlue(hostedGlueSource().then(site => {
    if (site?.torch) configureZippTorchSource(site.torch);
    return site ? site.glue : null;
  }));
}

// The components, registered as the runtimes register them: the start-up set
// now, and every other component (the light groups, charts, editors, Scene3D
// and Three.js, media) fetched the first time a page draws it.
registerRuntimeComponents();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DndProvider backend={HTML5Backend}>
      <AppBoundary>
        <App />
      </AppBoundary>
    </DndProvider>
  </React.StrictMode>
);
