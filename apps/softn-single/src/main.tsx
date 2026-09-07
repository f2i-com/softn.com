import { createRoot } from 'react-dom/client';
import { registerAllBuiltins } from '@softn/components';
import { SingleApp } from './SingleApp';
import './style.css';
registerAllBuiltins();
createRoot(document.getElementById('root')!).render(
  <SingleApp
    configUrl={
      new URL('runtime.config.json', new URL(import.meta.env.BASE_URL, document.baseURI)).href
    }
  />
);
