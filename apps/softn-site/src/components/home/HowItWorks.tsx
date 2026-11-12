import React from 'react';
import { Reveal } from '../Reveal';
import { BUILDER_HREF, STUDIO_HREF } from '../../lib/appUrls';
import { FORMAT_GUIDE_HREF, FORMLOGIC_GUIDE_HREF, PUBLISHING_GUIDE_HREF } from '../../lib/guides';

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
    name: 'Play an app',
    copy: (
      <>
        Pick one from <a href="/apps">the directory</a>. It opens in your browser: nothing to install, and no account.
      </>
    ),
    icon: icon(<path d="M8 5.5v13l10.5-6.5z" />),
  },
  {
    name: 'Open it up',
    copy: (
      <>
        Every app is one <a href={FORMAT_GUIDE_HREF}>.softn file</a> of pages, logic and pictures, as source you can read.
        Open any app in <a href={BUILDER_HREF}>Builder</a> or <a href={STUDIO_HREF}>Studio</a>.
      </>
    ),
    icon: icon(<><path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" /><path d="M14 3.5v5h5" /><path d="m10 13-2 2 2 2M14 13l2 2-2 2" /></>),
  },
  {
    name: 'Change it',
    copy: 'Arrange components in Builder, edit the code in JavaScript or Python, or describe the change to Studio’s AI. Try it at phone, tablet and desktop sizes as you go.',
    icon: icon(<><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></>),
  },
  {
    name: 'Publish it',
    copy: (
      <>
        <a href={PUBLISHING_GUIDE_HREF}>Publish it to the directory</a> for anyone to play, or{' '}
        <a href={FORMLOGIC_GUIDE_HREF}>host it with FormLogic</a> for sign-in, members and a shared database.
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
          <h2 className="band-title">Play it, open it, change it, publish it.</h2>
          <p className="band-sub">Every app in the directory is also a starting point. The same four steps take you from playing one to sharing your own, in tools that open in your browser.</p>
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
