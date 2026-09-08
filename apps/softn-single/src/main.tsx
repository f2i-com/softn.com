import { createRoot } from 'react-dom/client';
import { registerRuntimeComponents } from '@softn/components/lazy';
import { SingleApp } from './SingleApp';
import './style.css';
// The same registration as softn-web: the minimal set eagerly, every other
// built-in as a loader the registry runs when a document first needs it.
registerRuntimeComponents();
createRoot(document.getElementById('root')!).render(
  <SingleApp
    configUrl={
      new URL('runtime.config.json', new URL(import.meta.env.BASE_URL, document.baseURI)).href
    }
  />
);
