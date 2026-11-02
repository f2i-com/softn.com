import React from 'react';
import { LiveAppPreview } from '../LiveAppPreview';
import { FIELDNOTES_STARTER } from '../../lib/examples';

/**
 * The hero's proof: Fieldnotes, a real SoftN app, running in a card beside the words — add a task, complete one, watch
 * the counters move — with the way to make it yours. LiveAppPreview holds the runtime back until the page has loaded
 * and the card is near the screen, and on a phone or a saving connection until it is asked for.
 */
export function HeroApp(): React.ReactElement {
  return (
    <figure className="hero-app-card">
      <div className="hero-app-head">
        <span className="hero-app-label"><span aria-hidden="true" /> Fieldnotes <span className="hero-app-kind">a real SoftN app</span></span>
        <a className="hero-app-starter" href={FIELDNOTES_STARTER}>
          Use this starter <span aria-hidden="true">↗</span>
        </a>
      </div>
      <LiveAppPreview />
      <figcaption>Add a task or complete one: this is the app itself, with sample data that starts over each visit.</figcaption>
    </figure>
  );
}
