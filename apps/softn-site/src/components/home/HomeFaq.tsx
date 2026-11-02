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
        Partly, on purpose. A page can be written as an HTML page — <code>div</code>, <code>header</code>,{' '}
        <code>form</code>, <code>input</code>, <code>button</code>, classes and a <code>&lt;style&gt;</code> block — and
        SoftN reads it as a browser’s HTML parser would. It adds its own: components such as <code>&lt;Button&gt;</code>,{' '}
        <code>{'{expressions}'}</code>, <code>@click</code>, <code>:bind</code>, and <code>#if</code> and{' '}
        <code>#each</code> blocks. Code runs in SoftN’s sandbox rather than as the page’s own script, so a script written
        for an ordinary web page may need changes. <a href={HTML_GUIDE_HREF}>HTML and SoftN</a>
      </>
    ),
  },
  {
    q: 'Can I bring a website?',
    a: (
      <>
        A simple one, with some work. Pages in HTML and CSS carry across, and their scripts run in the sandbox with the
        APIs SoftN provides. Scripts loaded from other sites, a framework’s build output (React, Vue), npm packages and
        server code such as PHP do not come across as they are. Zip the site with its index.html, import the zip in
        Studio, then check it in Preview. <a href={HTML_GUIDE_HREF}>What carries across</a>
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
    <Reveal as="section" className="band band-faq" id="faq">
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
