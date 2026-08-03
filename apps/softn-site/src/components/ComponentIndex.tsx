import React from 'react';
import { Reveal } from './Reveal';
import { CATEGORIES, COMPONENT_COUNT } from '../data/components';

export function ComponentIndex(): React.ReactElement {
  return (
    <Reveal as="section" className="band" id="components">
      <div className="wrap">
        <div className="band-head">
          <span className="eyebrow">The library</span>
          <h2 className="band-title">{COMPONENT_COUNT} components, and no shopping list.</h2>
          <p className="band-sub">
            Charts, 3D scenes, a QR reader, a tile map, a pixel canvas and a streaming audio sink are in the same box
            as the buttons. Nothing here is a separate package to find, version and wire up — the whole list below is
            available to any bundle the moment you write its tag.
          </p>
        </div>

        <div className="cats">
          {CATEGORIES.map((cat) => (
            <div className="cat" key={cat.name}>
              <div className="cat-head">
                <h3 className="cat-name">{cat.name}</h3>
                <span className="cat-count">{String(cat.components.length).padStart(2, '0')}</span>
              </div>
              <ul className="cat-list">
                {cat.components.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </Reveal>
  );
}
