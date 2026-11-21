import React from 'react';
import { Reveal } from '../Reveal';
import {
  AI_PUBLISHING_GUIDE_HREF,
  DATA_GUIDE_HREF,
  FORMLOGIC_GUIDE_HREF,
  HOSTING_GUIDE_HREF,
  HTML_GUIDE_HREF,
  PUBLISHING_GUIDE_HREF,
  WEB_CONTAINERS_GUIDE_HREF,
} from '../../lib/guides';

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
    q: 'Can SoftN run real backend code locally in my browser?',
    a: (
      <>
        Yes. A SoftN v2 Web Container bundles standard frontend files alongside a real HTTP backend — PHP (including Slim
        4 and PDO SQLite), JavaScript, TypeScript, Rust, or Python — and an XDB SQLite database inside one{' '}
        <code>.softn</code> file. When opened in your browser, the backend executes inside a ZIPP WebAssembly Worker with
        IndexedDB persistence, so full-stack apps run completely locally with no server or Docker install.{' '}
        <a href={WEB_CONTAINERS_GUIDE_HREF}>Full-Stack Web Containers</a>
      </>
    ),
  },
  {
    q: 'Can I host the same app multi-user, and is backend code still sandboxed?',
    a: (
      <>
        Yes. Run the exact same <code>.softn</code> bundle through the directory’s flexible hosting (<code>browser</code>,{' '}
        <code>server</code>, or <code>hybrid</code> with <code>?mode=local</code>), on <code>softn-server</code>{' '}
        (single-app or multi-tenant), or on <code>softn-host-php</code> with zero app code changes. Every incoming
        backend request still executes inside ZIPP’s interpreter-only <code>safe-sandbox</code> VM (no native OS PHP,
        Python, or shell execution, strict memory and time bounds) against shared WAL SQLite on disk.{' '}
        <a href={HOSTING_GUIDE_HREF}>Hosting and multi-user sandboxing</a>
      </>
    ),
  },
  {
    q: 'Is this HTML?',
    a: (
      <>
        Yes. A SoftN v2 container runs standard HTML, CSS, JavaScript, TypeScript, and Python inside an isolated WebAssembly
        Worker and Shadow DOM viewport, with optional hosted modules (<code>preact</code>, <code>htm</code>,{' '}
        <code>three</code>, <code>marked</code>), <code>softn:db</code>, and on-demand <code>&lt;softn-*&gt;</code>{' '}
        elements — while remaining backwards-compatible with SoftN <code>.ui</code> templates.{' '}
        <a href={HTML_GUIDE_HREF}>HTML and SoftN</a>
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
        You can change your own copy. An app published to the directory as a bundle shows its source: open it in Studio
        or Builder, change it, and publish it as a remix, which credits the original. The original stays as its author published it — only
        their edit key changes it.
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
