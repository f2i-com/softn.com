import React from 'react';
import { Reveal } from '../Reveal';
import createImage from '../../assets/how-create.jpg';
import editImage from '../../assets/how-edit.jpg';
import previewImage from '../../assets/how-preview.jpg';
import publishImage from '../../assets/how-publish.jpg';
import { FORMLOGIC_GUIDE_HREF, PUBLISHING_GUIDE_HREF } from '../../lib/guides';

interface Step {
  name: string;
  copy: React.ReactNode;
  image: string;
  alt: string;
}

const STEPS: Step[] = [
  {
    name: 'Create or import',
    copy: 'Start from a working example or a template in Builder, describe the app to Studio’s AI, or open a .softn file you already have.',
    image: createImage,
    alt: 'SoftN Builder’s “Create a new app” dialog: a name, JavaScript or Python, and a blank page, a landing page or a dashboard to start from.',
  },
  {
    name: 'Change screens and logic',
    copy: 'Arrange components in Builder, or edit the page and its logic as code — JavaScript or Python.',
    image: editImage,
    alt: 'SoftN Builder’s code view with the Fieldnotes app’s logic file open.',
  },
  {
    name: 'Preview',
    copy: 'Run it as you go, at desktop, tablet and phone sizes. What you add in the preview is thrown away when you leave it.',
    image: previewImage,
    alt: 'SoftN Builder’s preview running the Fieldnotes task app.',
  },
  {
    name: 'Publish or host',
    copy: (
      <>
        <a href={PUBLISHING_GUIDE_HREF}>Publish it to the directory</a> for anyone to play, or{' '}
        <a href={FORMLOGIC_GUIDE_HREF}>host it with FormLogic</a> for sign-in, members and a shared database.
      </>
    ),
    image: publishImage,
    alt: 'The SoftN publish page: drop a .softn file, name it, describe it and pick a category.',
  },
];

/** The workflow in four steps, each shown in the tool where it happens. */
export function HowItWorks(): React.ReactElement {
  return (
    <Reveal as="section" className="band band-how" id="how">
      <div className="wrap">
        <div className="band-head">
          <p className="eyebrow">How it works</p>
          <h2 className="band-title">Create, change, preview, publish.</h2>
          <p className="band-sub">The same four steps whichever way you start, in tools that open in your browser.</p>
        </div>
        <ol className="how-steps">
          {STEPS.map((step, i) => (
            <li className="how-step" key={step.name}>
              <a className="how-shot" href={step.image} target="_blank" rel="noreferrer" aria-label={`View full-size screenshot: ${step.name}`}>
                <img src={step.image} alt={step.alt} width="1280" height="800" loading="lazy" decoding="async" />
              </a>
              <span className="how-n">{String(i + 1).padStart(2, '0')}</span>
              <h3 className="how-name">{step.name}</h3>
              <p className="how-copy">{step.copy}</p>
            </li>
          ))}
        </ol>
      </div>
    </Reveal>
  );
}
