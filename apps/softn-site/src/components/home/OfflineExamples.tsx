import { useState } from 'react';
import examples from '../../../../../examples/offline-web-apps/catalog.json';
import { exampleLinks } from '../../lib/examples';
import { Arrow, PlayGlyph } from '../glyphs';

export function OfflineExamples() {
  const [example, setExample] = useState(() => {
    const starter = new URLSearchParams(window.location.search).get('starter');
    return examples.find(item => item.id === starter) ?? examples[0];
  });
  const bundle = `/examples/${example.file}.softn`;
  const links = exampleLinks(bundle, `/?starter=${example.id}#offline-examples`);

  return (
    <section className="band band-split starter-band" id="create" aria-labelledby="starter-heading">
      <div className="wrap" id="offline-examples">
        <div className="band-head">
          <h2 className="band-title" id="starter-heading">Create an app</h2>
          <p className="band-sub">Choose a working starter, edit its source and see your changes in Studio or Builder.</p>
          <fieldset className="starter-choices">
            <legend>Choose a framework</legend>
            {examples.map(item => (
              <label className="starter-choice" key={item.id}>
                <input type="radio" name="starter-framework" checked={item === example} onChange={() => setExample(item)} />
                <span>{item.framework}</span>
              </label>
            ))}
          </fieldset>
        </div>
        <div className="starter-picker">
          <article className="starter-detail" aria-labelledby="starter-name">
            <div className="starter-overview">
              <h3 id="starter-name">{example.name}</h3>
              <p>{example.description}</p>
              <code className="starter-source">{example.source}</code>
              <div className="starter-actions">
                <a className="cta cta-primary" href={links.studio} aria-label={`Open ${example.name} in Studio`}>Open in Studio <Arrow /></a>
                <a className="cta" href={links.builder} aria-label={`Open ${example.name} in Builder`}>Open in Builder <Arrow /></a>
              </div>
              <a className="starter-link" href={bundle} download aria-label={`Download ${example.name}`}>Download app</a>
            </div>
            <a className="starter-preview" href={links.runtime} aria-label={`Run ${example.name}`}>
              <img src={`/examples/${example.file}.webp`} alt="" width="620" height="465" loading="lazy" decoding="async" />
              <span><PlayGlyph size={14} /> Run app</span>
            </a>
          </article>
          <p className="starter-offline">To use it offline, run the app once and wait for <strong>Offline ready</strong> in your Runtime library.</p>
        </div>
      </div>
    </section>
  );
}
