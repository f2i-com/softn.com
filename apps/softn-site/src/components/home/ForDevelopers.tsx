import React from 'react';
import { Reveal } from '../Reveal';
import { Code } from '../../lib/highlight';
import { REPO_URL } from '../../lib/appUrls';
import { FORMAT_GUIDE_HREF, HTML_GUIDE_HREF, PUBLISHING_GUIDE_HREF } from '../../lib/guides';
// The same file the guides show and core's docs-examples test runs, so the sample here is one that works.
import helloName from '../../../../../docs/examples/hello-name.ui?raw';

const LINKS: Array<{ href: string; label: string; detail: string; external?: boolean }> = [
  { href: HTML_GUIDE_HREF, label: 'See HTML differences', detail: 'What carries across from an HTML page, and what SoftN adds.' },
  { href: FORMAT_GUIDE_HREF, label: 'Inside a .softn file', detail: 'The manifest, the pages, the logic and the assets.' },
  { href: PUBLISHING_GUIDE_HREF, label: 'Publish with one request', detail: 'The directory’s API, for scripts and agents.' },
  { href: '/docs/', label: 'All the guides', detail: 'From a first app to hosting it yourself.' },
  { href: REPO_URL, label: 'Source on GitHub', detail: 'Apache License 2.0.', external: true },
];

/** For developers: a page written as HTML with SoftN in it, and where to read more. */
export function ForDevelopers(): React.ReactElement {
  return (
    <Reveal as="section" className="band band-split band-dev" id="developers">
      <div className="wrap">
        <div className="band-head">
          <p className="eyebrow">For developers</p>
          <h2 className="band-title">It reads like a page you already know.</h2>
          <p className="band-sub">
            Ordinary elements, a <code>class</code>, a <code>&lt;label for&gt;</code>. SoftN adds <code>:bind</code> to keep
            a field and a value in step, <code>@click</code> for events, <code>{'{expressions}'}</code> in the text, and a
            logic block that runs in its sandbox.
          </p>
        </div>
        <div className="dev-grid">
          <div className="dev-code">
            <div className="panel-bar">
              <span className="panel-bar-name">hello.ui</span>
              <span className="panel-bar-tag">markup</span>
            </div>
            <Code source={helloName.trimEnd()} className="lang-code" label="hello.ui source" language="markup" />
          </div>
          <ul className="dev-links">
            {LINKS.map((link) => (
              <li key={link.href}>
                <a href={link.href} {...(link.external ? { target: '_blank', rel: 'noreferrer' } : {})}>
                  <span className="dev-link-label">{link.label}</span>
                  <span className="dev-link-detail">{link.detail}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Reveal>
  );
}
