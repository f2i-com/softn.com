import React from 'react';
import { Reveal } from '../Reveal';
import { FORMAT_GUIDE_HREF, FORMLOGIC_GUIDE_HREF, HTML_GUIDE_HREF, PERMISSIONS_GUIDE_HREF } from '../../lib/guides';
import { ZIPP_URL } from '../../lib/appUrls';

/** What sets SoftN apart, in four points, two by two, each with the guide that backs it. */
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
            <h3 className="why-name">One file you keep</h3>
            <p className="why-copy">
              A <code>.softn</code> file holds the app’s pages, logic and assets as editable source. Download it, open it
              elsewhere, read every line. <a href={FORMAT_GUIDE_HREF}>What is inside</a>
            </p>
          </li>
          <li className="why">
            <h3 className="why-name">Written the way you already know</h3>
            <p className="why-copy">
              Pages read like HTML and logic is JavaScript or Python. Arrange it in Builder, write it in the code view, or
              describe it to Studio: each opens the others’ work. <a href={HTML_GUIDE_HREF}>HTML and SoftN</a>
            </p>
          </li>
          <li className="why">
            <h3 className="why-name">A sandbox that asks first</h3>
            <p className="why-copy">
              Logic runs on <a href={ZIPP_URL}>zipp</a>, an engine with nothing of the browser inside. The network, your
              camera, server storage: an app gets them only if it asks and you allow it. That is a boundary, not a
              promise that an app is harmless. <a href={PERMISSIONS_GUIDE_HREF}>Permissions</a>
            </p>
          </li>
          <li className="why">
            <h3 className="why-name">A backend when you want one</h3>
            <p className="why-copy">
              Apps run in the browser alone. One that declares storage gets a database where it is published, and{' '}
              <a href={FORMLOGIC_GUIDE_HREF}>FormLogic</a> adds sign-in, members, records and server code.
            </p>
          </li>
        </ul>
      </div>
    </Reveal>
  );
}
