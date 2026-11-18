import React from 'react';
import ReactDOM from 'react-dom/client';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
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
import { startNewProject } from './utils/newProject';
import { keepSavedPoint } from './utils/savedPoint';
import { useProjectStore } from './stores/projectStore';
import { awaitZippGlue, awaitZippWasmSource, cacheUncontrolledZippEngine, configureZippTorchSource } from '@softn/core/authoring';
import { hostedEngineSource, hostedGlueSource, isHostedEditor } from '@softn/editor-shared/hostedEditor';
import zippSource from '../../../packages/@softn/core/wasm-zipp/SOURCE.json';

// In FormLogic the engine comes from the page that opened the Builder, which
// has downloaded and checked it already: one file for the whole site, and the
// Builder FormLogic installs carries no copy of its own. With it, the glue of
// the site's own ZIPP where FormLogic serves one, so the Builder runs the ZIPP
// the site has, which may be newer than the one it was built with.
if (isHostedEditor()) {
  document.title = "FormLogic · Builder";
  awaitZippWasmSource(hostedEngineSource(zippSource));
  // The site's torch package with its glue: the one built for its engine.
  awaitZippGlue(hostedGlueSource().then(site => {
    if (site?.torch) configureZippTorchSource(site.torch);
    return site ? site.glue : null;
  }));
} else if (import.meta.env.PROD && !import.meta.env.TAURI_ENV_PLATFORM) {
  // A project can start its first full preview before the editor's service worker takes control.
  cacheUncontrolledZippEngine('softn-full-engine');
}

// Prepare the empty workspace before React can mount a classic canvas. A link
// or a restored project can then replace it with the format in its manifest.
const initialProject = useProjectStore.getState();
if (!isHostedEditor() && initialProject.revision === 0 && !initialProject.isDirty && initialProject.projectFormat === 'ui') {
  startNewProject({
    name: 'Untitled App', description: '', theme: 'system', template: 'blank',
    format: 'web', language: 'javascript', pythonPackages: [],
  });
  useProjectStore.getState().markClean();
  keepSavedPoint();
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DndProvider backend={HTML5Backend}>
      <AppBoundary>
        <App />
      </AppBoundary>
    </DndProvider>
  </React.StrictMode>
);
