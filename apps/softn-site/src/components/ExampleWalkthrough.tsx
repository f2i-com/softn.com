import React from 'react';
import { BUILDER_HREF, WEB_HREF } from '../lib/appUrls';
import { Reveal } from './Reveal';

export const FIELDNOTES_BUNDLE = '/examples/Fieldnotes.softn';

export function ExampleWalkthrough(): React.ReactElement {
  return (
    <Reveal as="section" className="band band-example" id="try-it">
      <div className="wrap">
        <div className="band-head">
          <p className="eyebrow">Meet Fieldnotes</p>
          <h2 className="band-title">One small app. The whole workflow.</h2>
          <p className="band-sub">A task planner you can use, inspect and change. Add an idea, mark it complete and see how the interface, logic and data work together.</p>
        </div>
        <ol className="example-flow">
          <li><span className="example-step">01 · Interface</span><h3>Start with a form</h3><p>Give your next task a name and choose a focus. The form checks it before saving.</p><code>ui/main.ui</code></li>
          <li><span className="example-step">02 · Logic</span><h3>Save a real record</h3><p>The app’s logic adds the task to its collection. Open the source to see the function behind the button.</p><code>logic/main.logic</code></li>
          <li><span className="example-step">03 · Data</span><h3>See your progress</h3><p>The list and totals update together. Complete a task, filter the list or come back to it later.</p><code>tasks.xdb</code></li>
        </ol>
        <div className="example-actions">
          <a className="cta cta-primary" href={`${WEB_HREF}?open=${encodeURIComponent(FIELDNOTES_BUNDLE)}&back=${encodeURIComponent('/#try-it')}`}>Try Fieldnotes <span aria-hidden="true">↗</span></a>
          <a className="cta" href={`${BUILDER_HREF}?open=${encodeURIComponent(FIELDNOTES_BUNDLE)}`}>Open example in Builder <span aria-hidden="true">↗</span></a>
          <a className="example-download" href={FIELDNOTES_BUNDLE} download="Fieldnotes.softn">Download the .softn app</a>
        </div>
        <p className="example-note">Sample data, ready to experiment with. The runtime saves your tasks in this browser. No account or AI connection needed.</p>
      </div>
    </Reveal>
  );
}
