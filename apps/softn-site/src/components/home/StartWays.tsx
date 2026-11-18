import { WEB_HREF } from '../../lib/appUrls';
import { FIELDNOTES_BUNDLE, FIELDNOTES_STARTER, fieldnotesInRuntime } from '../../lib/examples';
import { HTML_GUIDE_HREF } from '../../lib/guides';
import { Arrow } from '../glyphs';

export function StartWays() {
  return (
    <section className="band starter-alternatives" aria-label="More ways to start">
      <div className="wrap">
        <article id="try-it">
          <h2 className="band-title">Start with a working example</h2>
          <p>Try Fieldnotes, a classic SoftN task app. Open it in Builder to change its fields and layout visually.</p>
          <div className="starter-actions">
            <a className="cta" href={FIELDNOTES_STARTER}>Open the example <Arrow /></a>
            <a className="starter-link" href={fieldnotesInRuntime('/#try-it')}>Try it first</a>
            <a className="starter-link" href={FIELDNOTES_BUNDLE} download="Fieldnotes.softn">Download the .softn app</a>
          </div>
        </article>
        <article>
          <h2 className="band-title">Bring your own project</h2>
          <p>Open a web app folder, a ZIP or a SoftN bundle in Runtime to try it in the sandbox.</p>
          <div className="starter-actions">
            <a className="cta" href={WEB_HREF}>Open Runtime <Arrow /></a>
            <a className="starter-link" href={HTML_GUIDE_HREF}>Read the HTML guide</a>
          </div>
        </article>
      </div>
    </section>
  );
}
