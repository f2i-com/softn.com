/*
 * SoftN for a page of your own site.
 *
 *   <head>
 *     <script src="softn/softn.js"></script>
 *     ...
 *
 * Put this first in the page's <head>, with the runtime's folder beside the
 * page (here, softn/). The page is then a SoftN app: written as HTML, with
 * SoftN's components and syntax in it, and with its code in the files its
 * <script src> tags name, run in SoftN's sandbox rather than by the browser.
 *
 * Everything after this tag is read by SoftN, not drawn by the browser: the
 * runtime fetches the page's text and draws the app from it. A script tag
 * placed later, or written async, defer or as a module, cannot stop the
 * browser drawing what comes before it; the page is hidden instead until the
 * app is drawn.
 *
 * <script src="softn/softn.js" data-page="app.html"></script> runs another
 * page of the site in this one's place.
 */
(function () {
  var script = document.currentScript;
  if (!script || !script.src) return;
  var named = script.getAttribute('data-page');
  var pageUrl = (named ? new URL(named, document.baseURI).href : location.href).split('#')[0];
  window.__softnPage = { pageUrl: pageUrl, runtimeScripts: [script.src] };
  var parsing = document.readyState === 'loading' && !script.async && !script.defer;
  if (parsing && !named) {
    // The rest of the document is the app's source: the browser keeps it as
    // text, and runs none of its scripts and fetches none of its files.
    document.write('<plaintext hidden>');
  } else {
    if (!named) {
      console.warn(
        'SoftN: softn.js is not the first script in the page\'s <head>, or is async, deferred or a module, ' +
          'so the browser has drawn the page and run its scripts itself. Name it first in <head>, as a plain script.'
      );
    }
    var hide = document.createElement('style');
    hide.textContent = 'html[data-softn-page-loading] body { visibility: hidden; }';
    document.head.appendChild(hide);
    document.documentElement.setAttribute('data-softn-page-loading', '');
  }
  import(new URL('softn-page.js', script.src).href).catch(function (error) {
    document.documentElement.removeAttribute('data-softn-page-loading');
    document.body.textContent = 'This page could not start SoftN: ' + (error && error.message ? error.message : error);
  });
})();
