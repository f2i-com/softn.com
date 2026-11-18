import { createRoot } from 'react-dom/client';
import { SingleApp } from '@softn/single-shell/SingleApp';
import type { ConfigSource } from '@softn/single-shell/load';
import '@softn/single-shell/style.css';
/**
 * A page rendered by a directory for one of its apps carries the app's
 * configuration in the document; a standalone deployment reads the file
 * beside its entry. Nothing else can choose the app: not the query string,
 * not the hash, not a message.
 */
function configSource(): ConfigSource {
  const inline = document.getElementById('softn-runtime-config');
  if (inline instanceof HTMLScriptElement && inline.type === 'application/json') {
    return { configUrl: location.origin + location.pathname, inline: inline.textContent ?? '' };
  }
  return {
    configUrl: new URL('runtime.config.json', new URL(import.meta.env.BASE_URL, document.baseURI))
      .href,
  };
}
createRoot(document.getElementById('root')!).render(<SingleApp source={configSource()} />);
