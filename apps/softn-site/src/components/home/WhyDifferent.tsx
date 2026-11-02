import React from 'react';
import { Reveal } from '../Reveal';
import { FORMAT_GUIDE_HREF, FORMLOGIC_GUIDE_HREF, HTML_GUIDE_HREF, PERMISSIONS_GUIDE_HREF } from '../../lib/guides';
import { ZIPP_URL } from '../../lib/appUrls';

/** What sets SoftN apart, each point with the guide that backs it. */
export function WhyDifferent(): React.ReactElement {
  return (
    <Reveal as="section" className="band band-why" id="why">
      <div className="wrap">
        <div className="band-head">
          <p className="eyebrow">What makes SoftN different</p>
          <h2 className="band-title">An app you can read, run anywhere and take with you.</h2>
        </div>
        <ul className="why-grid">
          <li className="why">
            <h3 className="why-name">A portable source bundle</h3>
            <p className="why-copy">
              One <code>.softn</code> file holds the app’s pages, logic and assets as editable source. Download it, open it
              elsewhere, read every line. <a href={FORMAT_GUIDE_HREF}>What is inside</a>
            </p>
          </li>
          <li className="why">
            <h3 className="why-name">Familiar markup, JavaScript or Python</h3>
            <p className="why-copy">
              Pages read like HTML, with SoftN’s components and a few additions. Logic is JavaScript or Python, with the
              APIs SoftN provides. <a href={HTML_GUIDE_HREF}>HTML and SoftN</a>
            </p>
          </li>
          <li className="why">
            <h3 className="why-name">A sandbox with declared permissions</h3>
            <p className="why-copy">
              Logic runs on <a href={ZIPP_URL}>zipp</a>, an engine compiled to WebAssembly with nothing of the browser
              inside. The network, your camera, server storage: an app gets them only if its manifest asks and you allow
              it. That is a boundary, not a promise that an app is harmless. <a href={PERMISSIONS_GUIDE_HREF}>Permissions</a>
            </p>
          </li>
          <li className="why">
            <h3 className="why-name">Visual and code editing</h3>
            <p className="why-copy">
              Builder for components, data and layout at every screen size; the code view for everything; Studio when you
              would rather describe it. Each opens the others’ work.
            </p>
          </li>
          <li className="why">
            <h3 className="why-name">A backend when you want one</h3>
            <p className="why-copy">
              Apps run in the browser alone. An app that declares storage gets a database on the server it is published
              to; <a href={FORMLOGIC_GUIDE_HREF}>FormLogic</a> adds sign-in, members, records and server code.
            </p>
          </li>
        </ul>
      </div>
    </Reveal>
  );
}
