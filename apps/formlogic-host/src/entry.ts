import { documentEngines } from './engineInit';
import { framePolicy } from './framePolicy';

// Install the document's policy before fetching either renderer.
const engine = document.documentElement.getAttribute('data-softn-logic-engine');
const policy = document.createElement('meta');
policy.httpEquiv = 'Content-Security-Policy';
policy.content = framePolicy(new URL('./', document.baseURI).href, documentEngines(engine));
document.head.appendChild(policy);

if (engine === null && new URLSearchParams(location.search).get('format') === 'web') {
  void import('./web');
} else {
  void import('./main');
}
