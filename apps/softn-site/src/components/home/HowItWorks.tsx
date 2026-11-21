import React from 'react';
import { Reveal } from '../Reveal';
import { BUILDER_HREF, STUDIO_HREF } from '../../lib/appUrls';
import { FORMAT_GUIDE_HREF, HOSTING_GUIDE_HREF, PUBLISHING_GUIDE_HREF, WEB_CONTAINERS_GUIDE_HREF } from '../../lib/guides';

interface Step {
  name: string;
  copy: React.ReactNode;
  icon: React.ReactElement;
}

/** A step's picture: one line drawing, in the text's colour, that says what the step does at a glance. */
const icon = (paths: React.ReactNode) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths}
  </svg>
);

const STEPS: Step[] = [
  {
    name: 'Run a full app locally',
    copy: (
      <>
        Open any app from <a href="/apps">the directory</a> or index. Both frontend UI and sandboxed backend + SQLite boot right in your browser via ZIPP WASM — nothing to install.
      </>
    ),
    icon: icon(<path d="M8 5.5v13l10.5-6.5z" />),
  },
  {
    name: 'Open it up',
    copy: (
      <>
        Every app is one <a href={FORMAT_GUIDE_HREF}>.softn file</a> containing editable HTML, CSS, client logic, backend code (PHP, JS/TS, Rust, SQL) and assets. Open it in{' '}
        <a href={BUILDER_HREF}>Builder</a> or <a href={STUDIO_HREF}>Studio</a>.
      </>
    ),
    icon: icon(<><path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" /><path d="M14 3.5v5h5" /><path d="m10 13-2 2 2 2M14 13l2 2-2 2" /></>),
  },
  {
    name: 'Edit frontend & backend',
    copy: (
      <>
        Edit HTML/TS views alongside <a href={WEB_CONTAINERS_GUIDE_HREF}>sandboxed PHP, JS/TS, Rust or Python backends</a> and SQLite schemas in Builder, or let Studio’s AI build and verify changes in live preview.
      </>
    ),
    icon: icon(<><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></>),
  },
  {
    name: 'Share or host multi-user',
    copy: (
      <>
        <a href={PUBLISHING_GUIDE_HREF}>Publish to the directory</a> for private in-browser use, or run the exact same <code>.softn</code> bundle multi-user on{' '}
        <a href={HOSTING_GUIDE_HREF}>softn-server</a> — still strictly inside ZIPP’s sandbox.
      </>
    ),
    icon: icon(<><path d="M12 15V4" /><path d="m7.5 8.5 4.5-4.5 4.5 4.5" /><path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" /></>),
  },
];

/**
 * From playing an app to publishing your own, in four steps: every app in the directory is also a
 * starting point. Each step is a line of what you do and where, with no screenshot to decode.
 */
export function HowItWorks(): React.ReactElement {
  return (
    <Reveal as="section" className="band band-split band-how" id="how">
      <div className="wrap">
        <div className="band-head">
          <p className="eyebrow">How it works</p>
          <h2 className="band-title">Run it locally, open it, edit both sides, host anywhere.</h2>
          <p className="band-sub">Every .softn bundle is a complete, inspectable web app — frontend and sandboxed backend together. Move seamlessly from browser execution to multi-user hosting.</p>
        </div>
        <ol className="how-steps">
          {STEPS.map((step, i) => (
            <li className="how-step" key={step.name}>
              <div className="how-step-head">
                <span className="how-icon">{step.icon}</span>
                <span className="how-n">{String(i + 1).padStart(2, '0')}</span>
              </div>
              <h3 className="how-name">{step.name}</h3>
              <p className="how-copy">{step.copy}</p>
            </li>
          ))}
        </ol>
      </div>
    </Reveal>
  );
}
