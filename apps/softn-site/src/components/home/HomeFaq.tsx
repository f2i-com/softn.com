import React from 'react';
import { Reveal } from '../Reveal';
import { AI_PUBLISHING_GUIDE_HREF, DATA_GUIDE_HREF, FORMLOGIC_GUIDE_HREF, HTML_GUIDE_HREF, PUBLISHING_GUIDE_HREF } from '../../lib/guides';

interface Answer {
  q: string;
  a: React.ReactNode;
}

/**
 * The questions a newcomer asks, answered for SoftN as it is today. An answer that stops being true is a bug: these
 * claim nothing the runtime, the directory or FormLogic does not do.
 */
const FAQ: Answer[] = [
  {
    q: 'Is this HTML?',
    a: (
      <>
        Yes. A web container draws HTML and CSS and runs your app’s scripts in a WebAssembly Worker. You can
        also use SoftN’s optional <code>.ui</code> templates. <a href={HTML_GUIDE_HREF}>HTML and SoftN</a>
      </>
    ),
  },
  {
    q: 'What does Runtime download for offline use?',
    a: (
      <>
        Open the app online once. Runtime saves its files and the engine its code needs. Many vanilla JavaScript,
        React and Vue apps use the lite engine. Python and code that uses <code>Intl</code> need the full engine.
        A classic <code>.ui</code> app also installs its renderer and the components its pages use.
        Runtime Home shows when an app is ready to reopen offline. External services still need a connection.{' '}
        <a href={DATA_GUIDE_HREF}>Offline use and local data</a>
      </>
    ),
  },
  {
    q: 'Can I edit the React or Vue starter after exporting it?',
    a: (
      <>
        Yes. Reopen its <code>.softn</code> file in Studio or Builder and edit <code>app.js</code>,{' '}
        <code>App.jsx</code> or <code>App.vue</code>. Preview runs your change. Each editor downloads the
        JSX or Vue tools when you first preview that format, then keeps them for offline editing. If you
        import a compiled site, you can edit the files you included in the upload.
        {' '}<a href={HTML_GUIDE_HREF}>Working with web apps</a>
      </>
    ),
  },
  {
    q: 'Can I bring a website?',
    a: (
      <>
        Yes — client-side web apps and compiled static builds (<code>dist/index.html</code> from Vite, React, Preact, Vue,
        or Vanilla JS) can be zipped directly into a <code>.softn</code> container with zero rewrites, even without a{' '}
        <code>manifest.json</code>. External network calls stay blocked unless declared in <code>permission.json</code> and
        approved by the user. <a href={HTML_GUIDE_HREF}>What carries across</a>
      </>
    ),
  },
  {
    q: 'Can I edit someone else’s app?',
    a: (
      <>
        Open a directory bundle in Studio or Builder to edit your own copy of its files. Publishing your changes
        as a remix credits the original author. Updating their original listing requires their edit key.
      </>
    ),
  },
  {
    q: 'Where does my data live?',
    a: (
      <>
        In your browser, by default: the runtime keeps each app’s records on your device, and you can export them. An app
        that declares storage also gets a database on the server it is published to, shared by everyone who runs it, and
        the page asks you before it is used. Hosted with FormLogic, an app’s records live on that FormLogic site.{' '}
        <a href={DATA_GUIDE_HREF}>Data and offline use</a>
      </>
    ),
  },
  {
    q: 'What does FormLogic add?',
    a: (
      <>
        FormLogic hosts SoftN apps inside a workspace: sign-in and members with roles, a database with forms and records,
        automations, server code and your own domain. The app keeps its source; FormLogic adds the people and the data
        around it. <a href={FORMLOGIC_GUIDE_HREF}>SoftN and FormLogic</a>
      </>
    ),
  },
  {
    q: 'How can an AI publish for me?',
    a: (
      <>
        Studio’s AI writes and changes apps; publishing is your step. An AI agent connected to a FormLogic site can build
        an app there and prepare it for the directory, then hand you a link: nothing is public until you approve it.{' '}
        <a href={AI_PUBLISHING_GUIDE_HREF}>Publish with your AI agent</a>. A script can also publish a <code>.softn</code>{' '}
        with one request to the directory’s API, which answers with an edit key: whoever holds it can update the app, so
        keep it out of a model’s reach. <a href={PUBLISHING_GUIDE_HREF}>Publishing</a>
      </>
    ),
  },
];

export function HomeFaq(): React.ReactElement {
  return (
    <Reveal as="section" className="band band-split band-faq" id="faq">
      <div className="wrap">
        <div className="band-head">
          <p className="eyebrow">Questions</p>
          <h2 className="band-title">What people ask first.</h2>
        </div>
        <div className="faq-list">
          {FAQ.map((item) => (
            <details className="faq" key={item.q}>
              <summary className="faq-q">{item.q}</summary>
              <div className="faq-a">{item.a}</div>
            </details>
          ))}
        </div>
      </div>
    </Reveal>
  );
}
