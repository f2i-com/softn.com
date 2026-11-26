// react-dom's own entry beside its client, which requires it in any case. The
// runtime, Studio and the Builder import both, and importing the same two makes
// the play shell's React chunk (and the QR scanner's, which imports it) the
// same file as theirs (scripts/build/on-demand-chunks.mjs): the site keeps it
// once, and a browser that opened one keeps it for the other.
import 'react-dom';
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
