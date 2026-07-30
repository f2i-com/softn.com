import React, { useState } from 'react';
import { Reveal } from './Reveal';
import { Code } from '../lib/highlight';
import { SAMPLES } from '../data/language';

export function Language(): React.ReactElement {
  const [active, setActive] = useState(SAMPLES[0].id);
  const sample = SAMPLES.find((s) => s.id === active) ?? SAMPLES[0];

  return (
    <Reveal as="section" className="band" id="language">
      <div className="wrap">
        <div className="band-head">
          <span className="eyebrow">The language</span>
          <h2 className="band-title">Five ideas, and you have read the whole thing.</h2>
          <p className="band-sub">
            Tags for structure, braces for expressions, <code>@</code> to send an event out and <code>:</code> to bind a
            value both ways, <code>#</code> for control flow, and a <code>.logic</code> file for everything else. It is
            small on purpose — a language a model can write correctly on the first attempt is a language you can read.
          </p>
        </div>

        <div className="lang">
          <div className="lang-list" role="tablist" aria-label="Language examples">
            {SAMPLES.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                id={`lang-tab-${s.id}`}
                aria-selected={s.id === active}
                aria-controls={`lang-panel-${s.id}`}
                className="lang-tab"
                onClick={() => setActive(s.id)}
              >
                <span className="lang-tab-name">{s.name}</span>
                <span className="lang-tab-hint">{s.hint}</span>
              </button>
            ))}
          </div>

          <div className="lang-body">
            <div className="panel-bar">
              <span className="panel-bar-name">{sample.file}</span>
              <span className="panel-bar-tag">{sample.file.endsWith('.logic') ? 'logic' : 'markup'}</span>
            </div>
            <div
              role="tabpanel"
              id={`lang-panel-${sample.id}`}
              aria-labelledby={`lang-tab-${sample.id}`}
              style={{ display: 'contents' }}
            >
              <Code source={sample.source} className="lang-code" />
            </div>
          </div>
        </div>
      </div>
    </Reveal>
  );
}
