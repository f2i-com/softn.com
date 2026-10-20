/*
 * SoftN for a page of your own site.
 *
 *   <head>
 *     <script src="softn/softn.js"></script>
 *     ...
 *
 * Put this first in the page's <head>, as a plain script (not async, defer or
 * a module), with the runtime's folder beside the page (here, softn/). The
 * page is then a SoftN app: written as HTML, with SoftN's components and
 * syntax in it, and with its code in the files its <script src> tags name,
 * run in SoftN's sandbox rather than by the browser.
 *
 * Everything after this tag is read by SoftN, not by the browser: the browser
 * keeps it as text, draws none of it and runs none of its scripts, and the
 * runtime fetches the page's text and draws the app from it, the head's
 * viewport, theme-color and color-scheme metas included. The browser may
 * still request the files that markup names (pictures, scripts, stylesheets):
 * it looks ahead for them while this script loads, before this script has
 * run. Their answers go unused unless the app asks for the same file.
 *
 * Anything before this tag is the browser's: a plain script placed later in
 * the page leaves what comes before it drawn, and its scripts run, and makes
 * only what follows it text. Written async or defer, it can run after the
 * browser has read and drawn the page and run its scripts; the page is then
 * hidden from that moment until the app is drawn, and the console says why.
 * Written as a module it does nothing: a module has no document.currentScript
 * to find the runtime's folder by.
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
    // text, draws none of it and runs none of its scripts. What its markup
    // names may already have been requested by the browser's look-ahead,
    // which reads past this tag while the script loads.
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
